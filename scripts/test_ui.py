#!/usr/bin/env python3
"""Chromium UI acceptance against a real local Router API.

Normal machines use actual HTTP navigation. PSR_UI_OFFLINE_BROWSER=1 uses an
in-memory page and a Python HTTP bridge, for managed Chromium installations that
forbid URL navigation. It does NOT change browser policies. SSE itself is covered
by tests/http.test.ts; the bridge polls the identical update API for UI invalidation.
"""
from __future__ import annotations
import json, os, pathlib, shutil, socket, subprocess, tempfile, time, traceback, urllib.request
from datetime import datetime, timezone
from playwright.sync_api import sync_playwright, expect
ROOT = pathlib.Path(__file__).resolve().parents[1]
REPORTS = ROOT / 'reports'; REPORTS.mkdir(exist_ok=True)
checks: list[dict] = []
def check(name, fn):
    fn(); checks.append({'name': name, 'status': 'passed'}); print('PASS:',name,flush=True)
def require(condition, message='assertion failed'):
    assert condition, message
# The demo config has no seat template and no agent credential, so a service seat and its asks are written with the Router's
# own Store, exactly as createSession and psr_ask record them; the running Router then works them like any other.
SEED_JS="import { Store } from './dist/src/store.js'; const [path, rows] = process.argv.slice(-2); const s = new Store(path); for (const r of JSON.parse(rows)) s.put(r['kind'], r['id'], r['data'], r['projectId'] ?? null, r['hostId'] ?? null); s.close();"
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
base=f'http://127.0.0.1:{port}'
data=pathlib.Path(tempfile.mkdtemp(prefix='psr-ui-'))
log=open(data/'server.log','w')
server=subprocess.Popen(['node','--disable-warning=ExperimentalWarning','dist/src/main.js','--demo','--port',str(port),'--data',str(data/'state')],cwd=ROOT,stdout=log,stderr=subprocess.STDOUT)
mode='in-memory Chromium + real HTTP API bridge' if os.environ.get('PSR_UI_OFFLINE_BROWSER')=='1' else 'Chromium over HTTP'
error=None; errors=[]; calls=[] # when the console called the API: it shares the entry's 600-a-minute rate limit
try:
    for _ in range(100):
        try:
            urllib.request.urlopen(base+'/healthz',timeout=1).read(); break
        except Exception:
            if server.poll() is not None: raise RuntimeError((data/'server.log').read_text())
            time.sleep(.1)
    tokens=json.loads((data/'state/demo-tokens.json').read_text())
    token=tokens.get('PSR_WEB_TOKEN', tokens.get('web'))
    def api(name, args=None):
        req=urllib.request.Request(base+'/v1/tools/'+name,data=json.dumps(args or {}).encode(),headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'},method='POST')
        return json.loads(urllib.request.urlopen(req,timeout=8).read())
    def wait_task(prompt):
        for _ in range(100):
            matches=[t for t in api('psr_list_tasks')['tasks'] if t['prompt']==prompt]
            if matches and matches[0]['state']=='completed': return matches[0]
            page.wait_for_timeout(100)
        raise AssertionError('Task did not complete in the simulator')
    with sync_playwright() as p:
        executable=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium')
        browser=p.chromium.launch(**({'executable_path':executable} if executable else {}),headless=True,args=['--no-sandbox'])
        context=browser.new_context(viewport={'width':1600,'height':1050},device_scale_factor=1)
        page=context.new_page();page.set_default_timeout(8000); page.on('pageerror',lambda e:errors.append(str(e))); page.on('request',lambda r:calls.append(time.time()) if '/v1/' in r.url else None)
        if os.environ.get('PSR_UI_OFFLINE_BROWSER')=='1':
            def bridge(_source, payload):
                path=payload['path']; calls.append(time.time())
                req=urllib.request.Request(base+path,headers=payload.get('headers',{}),data=payload.get('body',None).encode() if payload.get('body') is not None else None,method=payload.get('method','GET'))
                try:
                    res=urllib.request.urlopen(req,timeout=8)
                    return {'status':res.status,'body':res.read().decode()}
                except urllib.error.HTTPError as e: return {'status':e.code,'body':e.read().decode()}
            page.expose_binding('__psrHttp',bridge)
            html=(ROOT/'web/index.html').read_text().replace('<link rel="stylesheet" href="/styles.css">','').replace('<script type="module" src="/app.js"></script>','')
            page.set_content(html)
            page.add_style_tag(content=(ROOT/'web/styles.css').read_text())
            page.add_script_tag(content=r'''
                const storage=new Map();
                Object.defineProperty(window,'sessionStorage',{value:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,String(v)),removeItem:k=>storage.delete(k)}});
                if(!crypto.randomUUID) crypto.randomUUID=()=> 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{const r=crypto.getRandomValues(new Uint8Array(1))[0]%16;return (c==='x'?r:(r&3)|8).toString(16)});
                window.fetch=async function(path,options={}){
                    path=String(path); const headers=Object.fromEntries(new Headers(options.headers??{}).entries());
                    if(path.startsWith('/v1/events?')) {
                        const q=new URLSearchParams(path.split('?')[1]);let cursor=q.get('after');let stopped=false,timer;
                        const stream=new ReadableStream({start(controller){
                            const poll=async()=>{if(stopped)return;try{const args={cursor,limit:100};if(q.get('projectId'))args.projectId=q.get('projectId');if(q.get('hostId'))args.hostId=q.get('hostId');const r=await window.__psrHttp({path:'/v1/tools/psr_read_updates',method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify(args)});if(stopped)return;const data=JSON.parse(r.body);if(r.status!==200){controller.enqueue(new TextEncoder().encode('event: resync_required\ndata: '+r.body+'\n\n'));controller.close();stopped=true;return;}cursor=data.cursor;controller.enqueue(new TextEncoder().encode('event: changes\ndata: '+r.body+'\n\n'));timer=setTimeout(poll,1000);}catch(e){if(!stopped){stopped=true;controller.error(e);}}};poll();options.signal?.addEventListener('abort',()=>{stopped=true;clearTimeout(timer);try{controller.close()}catch{}});
                        },cancel(){stopped=true;clearTimeout(timer)}});return new Response(stream,{headers:{'content-type':'text/event-stream'}});
                    }
                    const r=await window.__psrHttp({path,headers,method:options.method??'GET',body:options.body??null});return new Response(r.body,{status:r.status,headers:{'content-type':'application/json'}});
                };
            ''')
            page.add_script_tag(content=(ROOT/'web/app.js').read_text(),type='module')
        else:
            page.goto(base)
        page.locator('#token').fill(token);page.locator('#login-form button').click()
        expect(page.locator('#park')).to_be_visible();expect(page.locator('.park-loading')).to_have_count(0,timeout=20000);page.locator('[data-view="machines"]').click()
        expect(page.locator('.s-item')).to_have_count(5)
        check('login and the machines view show five sessions on three simulated hosts',lambda:require(page.locator('.h-card:not(.h-all)').count()==3))
        check('simulation boundary is visible in the UI',lambda:require('模擬環境' in page.locator('#park-mode').inner_text()))
        data_sessions=api('psr_list_sessions')['sessions'];selected=next(s for s in data_sessions if s['daemonId']=='gpu-research' and s['nativeId']=='agent-2')
        ref=selected['id'];page.locator(f'#pg-session-list [data-session="{ref}"]').click()
        check('selecting a session shows its exact session ID and machine',lambda:require(ref in page.locator('#park-inspector').inner_text() and 'GPU · Research' in page.locator('#park-inspector').inner_text()))
        page.screenshot(path=str(REPORTS/'console-machines.png'),full_page=True)
        page.locator('#park-inspector .composer textarea').fill('UI test: validate queue model without real execution')
        page.locator('#park-inspector .composer button[type=submit]').click()
        page.wait_for_timeout(300); print('SUBMIT:',page.locator('#toast').text_content(),flush=True)
        completed=wait_task('UI test: validate queue model without real execution')
        check('submit creates a real persisted task through the shared API',lambda:require(completed['target']==ref and completed['originKind']=='web'))
        check('simulated completion remains separate from verification',lambda:require(completed['verification']['status']=='not_run' and '[SIMULATED RESULT]' in completed['resultSummary']))
        page.locator('[data-view="tasks"]').click();page.locator(f'#pg-task-tree [data-task="{completed["id"]}"]').first.click()
        expect(page.locator('#park-inspector .task-title')).to_be_visible();expect(page.locator('#park-inspector')).to_contain_text('[SIMULATED RESULT]')
        check('task panel shows the result and that completion is not verification',lambda:require('[SIMULATED RESULT]' in page.locator('#park-inspector').inner_text() and '未驗收' in page.locator('#park-inspector').inner_text()))
        target=next(s for s in data_sessions if s['daemonId']=='lab-test')
        page.locator('#park-inspector details[data-open-key^="handoff:"] summary').click()
        page.locator('#park-inspector .handoff-form select').select_option(target['id']);page.locator('#park-inspector .handoff-form textarea').fill('UI handoff: independently review the queue result');page.locator('#park-inspector .handoff-form button[type=submit]').click()
        page.wait_for_timeout(500); print('HANDOFF:',page.locator('#toast').text_content(),flush=True)
        for _ in range(50):
            child=[t for t in api('psr_list_tasks')['tasks'] if t['dependencyId']==completed['id']]
            if child: break
            page.wait_for_timeout(100)
        check('handoff preserves a concrete source task and target session',lambda:require(bool(child) and child[0]['target']==target['id']))
        page.wait_for_timeout(400)
        check('the task view nests the handoff under its source task',lambda:require(page.locator(f'#pg-task-tree .t-node .t-node [data-task="{child[0]["id"]}"]').count()==1))
        page.screenshot(path=str(REPORTS/'console-tasks.png'),full_page=True)
        page.locator('#pg-task-tree [data-mission]').first.click();expect(page.locator('#park-inspector .m-progress')).to_be_visible()
        check('a multi-step mission is one plant in the garden with its steps in the panel',lambda:require(page.locator('.park-tag-mission').count()>=1 and '步驟' in page.locator('#park-inspector').inner_text() and page.locator('.park-tag-area').count()==2))
        page.screenshot(path=str(REPORTS/'console-garden.png'))
        page.locator('#park-inspector details[data-open-key^="regroup:"] summary').click()
        page.locator('#park-inspector .regroup-form input[name=other]').first.check()
        page.locator('#park-inspector .regroup-form input[name=part]').fill('UI 子任務');page.locator('#park-inspector .regroup-form button[type=submit]').click()
        expect(page.locator('#park-inspector')).to_contain_text('UI 子任務')
        check('整理 merges another mission in as a named part (子任務) of this one',lambda:require(sum(t.get('missionPart')=='UI 子任務' for t in api('psr_list_tasks')['tasks'])>=1 and page.locator('#park-inspector .m-part').filter(has_text='UI 子任務').count()==1))
        page.locator('[data-view="machines"]').click();page.locator(f'#pg-session-list [data-session="{ref}"]').click()
        page.locator('#park-inspector [data-dispatch]').click();expect(page.locator('#park-inspector [data-dispatch]')).to_have_text('恢復派工')
        check('pause is a shared server-side dispatch mode',lambda:require(api('psr_get_session',{'sessionRef':ref})['worker']['mode']=='paused'))
        page.locator('#park-inspector .composer textarea').fill('UI pause queue test');page.locator('#park-inspector .composer button[type=submit]').click();page.wait_for_timeout(1100)
        queued=[t for t in api('psr_list_tasks')['tasks'] if t['prompt']=='UI pause queue test'][0]
        check('paused worker accepts a queue receipt but does not execute it',lambda:require(queued['state']=='queued'))
        page.locator(f'#pg-session-list [data-session="{ref}"]').click()
        page.locator('#park-inspector [data-dispatch]').click();expect(page.locator('#park-inspector [data-dispatch]')).to_have_text('暫停後續派工')
        wait_task('UI pause queue test')
        check('resume releases queued work through the same scheduler',lambda:require(api('psr_get_task',{'taskId':queued['id']})['state']=='completed'))
        page.locator(f'#pg-session-list [data-session="{ref}"]').click()
        page.locator('#park-inspector details[data-frontier] summary').click();expect(page.locator('#park-inspector .fr-form')).to_be_visible()
        page.locator('#park-inspector .fr-form input[name="card"]').fill('ui-validation');page.locator('#park-inspector .fr-form textarea[name="current"]').fill('Validated queue behavior from the UI');page.locator('#park-inspector .fr-form textarea[name="next"]').fill('Run live daemon acceptance')
        page.locator('#park-inspector .fr-form button').click();page.wait_for_timeout(400)
        frontier=api('psr_get_frontier',{'workspaceId':selected['workspaceId']})
        check('Frontier editor writes the current card using revision checks',lambda:require(frontier['cards']['ui-validation']['current']=='Validated queue behavior from the UI'))
        page.locator('#park-inspector .inspector-close').click()
        page.locator('#pg-session-q').fill('queue-model');expect(page.locator('.s-item')).to_have_count(1)
        check('search narrows the session list',lambda:require('queue-model' in page.locator('.s-item').inner_text()))
        page.locator('#pg-session-q').fill('');page.locator('.h-card[data-host="dev2"]').click();expect(page.locator('.s-item')).to_have_count(1)
        check('choosing a machine shows only its sessions',lambda:require('frontend' in page.locator('.s-item').inner_text()))
        page.locator('.h-card[data-host="all"]').click();expect(page.locator('.s-item')).to_have_count(5)
        page.locator('[data-view="tasks"]').click();page.locator('#pg-task-client').select_option('grokbot');page.wait_for_timeout(200)
        check('the entry filter keeps only task trees that involve that entry',lambda:require(page.locator('#pg-task-tree .t-row').count()>0 and 'Grokbot' in page.locator('#pg-task-tree').inner_text()))
        page.locator('#pg-task-client').select_option('all')
        page.locator('#pg-goal textarea[name=text]').fill('UI 目標：查一下各機器的磁碟');page.locator('#pg-goal input[name=title]').fill('UI 磁碟目標');page.locator('#pg-goal button[type=submit]').click()
        expect(page.locator('#park-inspector .goal-box')).to_be_visible()
        check('the console hands the planner a goal, shown as its own task with the conversation',lambda:require(any(g['title']=='UI 磁碟目標' and g['state']=='open' for g in api('psr_list_goals')['goals']) and page.locator('#pg-task-tree [data-mission]').filter(has_text='UI 磁碟目標').count()==1 and 'UI 目標' in page.locator('#park-inspector .goal-text').inner_text()))
        # ---- the mission forum (論壇): a post made elsewhere shows as text, and the owner posts from the panel ----
        goal_id=next(g['id'] for g in api('psr_list_goals')['goals'] if g['title']=='UI 磁碟目標')
        api('psr_forum_post',{'mission':goal_id,'text':'資料在 /srv/data <img src=x onerror="window.__forumXss=1">'})
        forum=page.locator('#park-inspector details[data-forum]');forum.locator('summary').click();expect(forum.locator('.forum-post')).to_have_count(1)
        forum.locator('.forum-form textarea[name=text]').fill('UI 論壇貼文');forum.locator('.forum-form button[type=submit]').click();expect(forum.locator('.forum-post')).to_have_count(2)
        check('the mission panel shows its 論壇: post text stays text and the owner posts there',lambda:require('<img src=x' in forum.inner_text() and forum.locator('img').count()==0 and page.evaluate('window.__forumXss') is None and [x['author']['kind'] for x in api('psr_forum_read',{'mission':goal_id})['posts']]==['owner','owner'] and 'UI 論壇貼文' in forum.inner_text()))
        # the form counts UTF-8 bytes as the Router does (maxlength counts characters): 700 Chinese characters are 2100 bytes
        forum.locator('.forum-form textarea[name=text]').fill('測'*700);forum.locator('.forum-form button[type=submit]').click();expect(page.locator('#toast')).to_contain_text('2000 bytes')
        check('the 論壇 form stops a post over 2000 bytes before sending it, with a toast saying why',lambda:require(len(api('psr_forum_read',{'mission':goal_id})['posts'])==2 and forum.locator('.forum-post').count()==2))
        forum.locator('.forum-form textarea[name=text]').fill('')
        page.locator('[data-view="policy"]').click();expect(page.locator('#pg-policy .lv-row')).to_have_count(5)
        page.locator('#pg-policy [data-approver="frontend"][data-level="L1"]').check();page.wait_for_timeout(600)
        page.locator('#pg-policy form[data-form="test"] input[name=cmd]').fill('nvm install 22');page.locator('#pg-policy form[data-form="test"] button').click();expect(page.locator('#pg-test-out')).to_contain_text('L2')
        check('權限 sets who answers each level and judges a command by the rules',lambda:require('frontend' in api('psr_get_policy')['levels'][1]['approvers'] and 'install' in page.locator('#pg-test-out').inner_text()))
        page.locator('[data-view="machines"]').click();page.locator(f'#pg-session-list [data-session="{ref}"]').click()
        page.locator('#park-inspector .composer textarea').fill('UI live card test');page.locator('#park-inspector .composer button[type=submit]').click()
        expect(page.locator('.live-card').filter(has_text='UI live card test')).to_be_visible(timeout=6000)
        check('a running task shows a live card with its steps above the agent',lambda:require(page.locator('.live-card').filter(has_text='UI live card test').count()==1))
        page.locator('.park-dock [data-park="showcase"]').click();expect(page.locator('#park-counter')).to_be_visible()
        check('展示 hides the panels and keeps the running count and the clock',lambda:require(page.locator('.park-brand').is_hidden() and '任務進行中' in page.locator('#park-counter').inner_text() and page.locator('#park-clock').is_visible()))
        page.keyboard.press('Escape');expect(page.locator('.park-brand')).to_be_visible()
        # ---- agent as a service (psr_ask): a service added on 權限, a seat, and a two-level chain the real engine works ----
        def seed(rows):
            subprocess.run(['node','--disable-warning=ExperimentalWarning','--input-type=module','-e',SEED_JS,str(data/'state/router.sqlite'),json.dumps(rows)],cwd=ROOT,check=True,timeout=30)
        page.locator('[data-view="policy"]').click();card=page.locator('#pg-policy [data-card="a2a"]');expect(card).to_be_visible()
        card.locator('details[data-open-key="svc:"] summary').click();form=card.locator('form[data-form="service"][data-name=""]')
        form.locator('input[name=name]').fill('market-data');form.locator('textarea[name=description]').fill('Where A-share market data lives and how to read it')
        form.locator('input[name=callers][value="*"]').check();form.locator('select[name=autoAllow]').select_option('L0');form.locator('button[type=submit]').click()
        expect(card.locator('.svc-row[data-service="market-data"]')).to_be_visible()
        check('權限 › 服務呼叫 adds a service through psr_set_policy',lambda:require(any(x['name']=='market-data' and x['callers']==['*'] and x['autoAllow']=='L0' for x in api('psr_get_policy')['a2a']['services'])))
        md_policy={**next(x for x in api('psr_get_policy')['a2a']['services'] if x['name']=='market-data'),'mayCall':['ingest']}
        api('psr_set_policy',{'a2a':{'services':[md_policy,{'name':'ingest','description':'Pulls new bars into the datastore','callers':[]}]}})
        seat=next(s for s in api('psr_list_sessions')['sessions'] if s['daemonId']=='gpu-review');now=int(time.time()*1000)
        md_ask,sub_ask='ask_ui0marketdata','ask_ui0ingest';request='2019 年後 A 股 1 分鐘線在哪、怎麼讀？<img src=x onerror="window.__askXss=1">'
        ask=lambda **k:{'topic':None,'state':'queued','seatRef':None,'turnTaskIds':[],'answer':None,'createdAt':now,'deadlineAt':now+3600000,'settledAt':None,'delivery':'held','deliveredAt':None,'deliveredTaskId':None,'dropReason':None,'waitingSub':[],'updatedAt':now,**k}
        md_row={'kind':'ask','id':md_ask,'projectId':selected['projectId'],'hostId':selected['hostId'],'data':ask(id=md_ask,service='market-data',request=request,topic='ashare-1m',callerSession=ref,callerTask=completed['id'],callerClientId='web',parentAsk=None,path=['market-data'],depth=1,waitingSub=[sub_ask])}
        sub_row=lambda caller_task:{'kind':'ask','id':sub_ask,'projectId':seat['projectId'],'hostId':seat['hostId'],'data':ask(id=sub_ask,service='ingest',request='補 2024-06 起的 1 分鐘線進 datastore，完成後回報表名和讀法',callerSession=seat['id'],callerTask=caller_task,callerClientId='router',parentAsk=md_ask,path=['market-data','ingest'],depth=2)}
        seed([{'kind':'creation','id':'ui-seat-market-data','projectId':seat['projectId'],'hostId':seat['hostId'],'data':{'templateId':'ui-seat','state':'completed','sessionRef':seat['id'],'role':'service','service':'market-data','updatedAt':now}},md_row,sub_row(completed['id'])])
        for _ in range(100):
            md=next((a for a in api('psr_list_asks')['asks'] if a['id']==md_ask),None)
            if md and md['turnTaskIds']: break
            page.wait_for_timeout(100)
        turn=md['turnTaskIds'][0];seed([sub_row(turn)]) # the sub-ask is the seat's own call, made in its service turn
        for _ in range(100):
            if api('psr_get_task',{'taskId':turn})['state']=='completed': break
            page.wait_for_timeout(100)
        check('the engine gives the call to the seat, and the chain waits for its sub-service after the turn ends',lambda:require(api('psr_get_task',{'taskId':turn})['routerTurn']=='service' and next(a for a in api('psr_list_asks')['asks'] if a['id']==md_ask)['state']=='running' and next(a for a in api('psr_list_asks')['asks'] if a['id']==sub_ask)['state']=='queued'))
        expect(card.locator(f'[data-seat="{seat["id"]}"]')).to_be_visible();expect(card).to_contain_text(md_ask)
        check('權限 › 服務呼叫 lists the services, the seat and the call it is answering',lambda:require(card.locator('.svc-row').count()==2 and 'ingest' in card.inner_text() and md_ask in card.inner_text() and page.locator('#pg-policy .lv-row').count()==5))
        page.locator('[data-view="overview"]').click();ribbon=page.locator('#park-stats .park-ribbon');expect(ribbon).to_contain_text('服務呼叫 2')
        check('the stats card gains a 服務呼叫 line while asks are open',lambda:require(ribbon.locator('[data-ribbon="calls"]').inner_text().strip()=='服務呼叫 2'))
        ribbon.locator('[data-ribbon="calls"]').click();expect(page.locator('#park-inspector .ask-ladder')).to_have_count(1)
        page.locator(f'#park-inspector .ask-ladder [data-task="{completed["id"]}"]').click();expect(page.locator('#park-inspector .task-title')).to_be_visible()
        ladder=page.locator('#park-inspector .ask-ladder');expect(ladder.locator('.ask-hop')).to_have_count(3)
        hops=[h.inner_text() for h in ladder.locator('.ask-hop').all()]
        check('a caller task shows its chain ladder (caller → market-data → ingest) with the request quoted as text',lambda:require((selected.get('displayName') or (selected.get('worker') or {}).get('alias') or selected['title']) in hops[0] and '等回覆' in hops[0] and 'market-data' in hops[1] and '等下游 ingest' in hops[1] and 'ingest' in hops[2] and '排隊' in hops[2] and '<img src=x' in hops[1] and ladder.locator('img').count()==0 and page.evaluate('window.__askXss')is None,str(hops)))
        ladder.locator(f'[data-task="{turn}"]').click();expect(page.locator('#park-inspector .eyebrow').first).to_contain_text('服務呼叫')
        check('a service turn shows the chain it answers',lambda:require(page.locator('#park-inspector .ask-ladder .ask-hop').count()==3 and 'market-data' in page.locator('#park-inspector .task-title').inner_text()))
        page.locator('#park-inspector .inspector-close').click()
        page.locator('[data-view="machines"]').click();page.set_viewport_size({'width':390,'height':844});page.wait_for_timeout(300)
        page.screenshot(path=str(REPORTS/'console-mobile.png'),full_page=True)
        overflow=page.evaluate('document.documentElement.scrollWidth > window.innerWidth+1')
        check('mobile machines view has no document-wide horizontal overflow',lambda:require(not overflow))
        page.locator('[data-view="policy"]').click();expect(page.locator('#pg-policy [data-card="a2a"]')).to_be_visible();page.locator('#pg-policy details[data-open-key="svc:market-data"] summary').click()
        wide=page.evaluate("[document.documentElement.scrollWidth>window.innerWidth+1, ...['#pg-policy','#park-stats'].map(s=>{const e=document.querySelector(s);return e.scrollWidth>e.clientWidth+1})]")
        page.locator('[data-view="overview"]').click();page.locator('#park-stats [data-ribbon="calls"]').click();expect(page.locator('#park-inspector .ask-ladder')).to_have_count(1)
        wide+=page.evaluate("[document.documentElement.scrollWidth>window.innerWidth+1, (e=>e.scrollWidth>e.clientWidth+1)(document.querySelector('#park-inspector'))]")
        page.locator('#park-inspector .inspector-close').click()
        # at this width the 任務 page squeezes its tree under the goal form and filters, so the row is picked with a DOM click
        page.locator('[data-view="tasks"]').click();page.locator('#pg-task-tree [data-mission]').filter(has_text='UI 磁碟目標').dispatch_event('click');expect(page.locator('#park-inspector details[data-forum] .forum-post')).to_have_count(2) # it stays open (openSections)
        wide+=page.evaluate("[document.documentElement.scrollWidth>window.innerWidth+1, (e=>e.scrollWidth>e.clientWidth+1)(document.querySelector('#park-inspector'))]")
        check('at phone width the 服務呼叫 card, the ribbon, the chain ladder and the 論壇 fit without horizontal scroll',lambda:require(not any(wide),str(wide)))
        busiest=max((sum(t<=u<t+60 for u in calls) for t in calls),default=0)
        check('the console stays well inside the entry rate limit of 600 calls a minute',lambda:require(busiest<=400,f'{busiest} console calls in the busiest minute'))
        check('browser application runs without uncaught JavaScript exceptions',lambda:require(not errors,str(errors)))
        context.close();browser.close()
except Exception as exc:
    error=traceback.format_exc();checks.append({'name':'UI run','status':'failed','error':str(exc)});print(error)
finally:
    server.terminate()
    try: server.wait(timeout=8)
    except subprocess.TimeoutExpired: server.kill();server.wait()
    log.close()
    report={'generatedAt':datetime.now(timezone.utc).isoformat(),'transport':mode,'realPaseo':False,'realVendorAccounts':False,'passed':sum(c['status']=='passed' for c in checks),'failed':sum(c['status']=='failed' for c in checks),'checks':checks,'browserErrors':errors,'error':error}
    (REPORTS/'ui-tests.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
    if error: (REPORTS/'ui-server-failure.log').write_text((data/'server.log').read_text())
    shutil.rmtree(data,ignore_errors=True)
print(json.dumps({'passed':report['passed'],'failed':report['failed'],'transport':mode},ensure_ascii=False))
raise SystemExit(1 if error else 0)
