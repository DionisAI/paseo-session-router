#!/usr/bin/env python3
"""Optional authoritative Frontier JSON store (POSIX; Python standard library only).
Not an adapter for the user's existing `worklog` CLI. Do not point this at an
existing worklog directory. RPC is one JSON request on stdin, one JSON reply.
"""
import argparse, fcntl, hashlib, json, os, pathlib, sys

def validate(state):
    assert isinstance(state,dict) and isinstance(state.get('workspaceId'),str)
    assert isinstance(state.get('revision'),int) and state['revision']>=0
    assert isinstance(state.get('cards'),dict) and len(state['cards'])<=16
    assert isinstance(state.get('notes'),dict) and len(state['notes'])<=3
    assert len(json.dumps(state,ensure_ascii=False,separators=(',',':')).encode())<=32768
    for key,text in state['notes'].items():
        assert key in ('1','2','3') and isinstance(text,str) and len(text.encode())<=1024
    for key,card in state['cards'].items():
        assert isinstance(card,dict) and card.get('id')==key
        assert len(json.dumps(card,ensure_ascii=False,separators=(',',':')).encode())<=4096
        assert len(card.get('blockers',[]))<=8 and len(card.get('refs',[]))<=8

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--root',required=True);args=parser.parse_args()
    raw=sys.stdin.buffer.read(65537)
    if len(raw)>65536: raise ValueError('PAYLOAD_TOO_LARGE')
    request=json.loads(raw)
    workspace=request.get('workspaceId')
    if not isinstance(workspace,str) or not workspace or len(workspace)>160: raise ValueError('INVALID_WORKSPACE')
    root=pathlib.Path(args.root).resolve();root.mkdir(parents=True,exist_ok=True,mode=0o700)
    key=hashlib.sha256(workspace.encode()).hexdigest();path=root/(key+'.json')
    # One global lock avoids growing lock files on arbitrary rejected workspaces.
    fd=os.open(root/'frontier.lock',os.O_CREAT|os.O_RDWR,0o600)
    with os.fdopen(fd,'a+') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        if path.exists(): current=json.loads(path.read_text())
        else: current={'workspaceId':workspace,'projectId':request.get('projectId'),'hostId':request.get('hostId'),'revision':0,'cards':{},'notes':{}}
        if request.get('operation')=='get': pass
        elif request.get('operation')=='compare_and_swap':
            if request.get('expectedRevision')!=current['revision']: raise ValueError('FRONTIER_CONFLICT')
            value=request.get('next');validate(value)
            if value['workspaceId']!=workspace or value['revision']!=current['revision']+1: raise ValueError('INVALID_REVISION')
            if current['revision'] and (current['projectId']!=value['projectId'] or current['hostId']!=value['hostId']): raise ValueError('IDENTITY_MISMATCH')
            if not path.exists() and len(list(root.glob('*.json')))>=2000: raise ValueError('WORKSPACE_QUOTA')
            temp=root/'frontier.tmp'
            out=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
            with os.fdopen(out,'w') as f:
                json.dump(value,f,ensure_ascii=False,separators=(',',':'));f.flush();os.fsync(f.fileno())
            os.replace(temp,path)
            directory=os.open(root,os.O_RDONLY)
            try: os.fsync(directory)
            finally: os.close(directory)
            current=value
        else: raise ValueError('UNSUPPORTED_OPERATION')
        validate(current);print(json.dumps(current,ensure_ascii=False,separators=(',',':')))

if __name__=='__main__':
    try: main()
    except Exception as exc:
        print(str(exc) or type(exc).__name__,file=sys.stderr);sys.exit(2)
