import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyRequest, splitCommand, checkRules, resolvePath, type PolicyRule } from '../src/policy.js';
const cwd = '/home/agent/psr-joint';
const level = (detail: string, rules: PolicyRule[] = [], disabled: string[] = [], tool = 'Bash') => classifyRequest({ tool, detail }, cwd, { rules, disabled }).level;
test('policy: commands are judged by what they do, the riskiest step of a chain wins, and anything unknown is L4', () => {
    const cases: [string, string][] = [
        ['ls -la', 'L0'], ['node --version', 'L0'], ['nvm ls', 'L0'], ['cat README.md | grep foo', 'L0'], ['git status && git diff', 'L0'], ['timeout 10 node --version', 'L0'], ['FOO=1 node -v', 'L0'],
        ['systemctl status nginx', 'L0'], ['docker ps', 'L0'], ['find . -name x', 'L0'], ['sed -n 1,5p x', 'L0'], ['echo hi > /dev/null', 'L0'], ['bash -lc node --version', 'L0'],
        ['git commit -am x', 'L1'], ['echo hi > notes.txt', 'L1'], ['mkdir -p build && touch build/x', 'L1'], ['cd sub && touch a', 'L1'], ['sed -i s/a/b/ config.yaml', 'L1'],
        ['rm -rf build', 'L2'], ['npm install', 'L2'], ['nvm install 22', 'L2'], ['pip install requests', 'L2'], ['python3 run.py', 'L2'], ['curl https://example.com', 'L2'], ['docker run x', 'L2'],
        ['echo hi > /etc/motd', 'L3'], ['rm -rf /var/log/x', 'L3'], ['cd /etc && rm hosts', 'L3'], ['sudo apt-get install -y nodejs', 'L3'], ['sudo cat /var/log/syslog', 'L3'], ['systemctl restart nginx', 'L3'],
        ['systemctl --user restart paseo', 'L3'], ['service nginx restart', 'L3'], ['kill 123', 'L3'], ['docker restart x', 'L3'], ["bash -lc 'cd /tmp && rm -rf x'", 'L3'], ['ls; reboot', 'L3'],
        ['cat .env', 'L4'], ['cat ~/.ssh/id_ed25519', 'L4'], ['ls ~/.ssh', 'L4'], ['printenv', 'L4'], ['echo $API_KEY', 'L4'], ['ls $(cat .env)', 'L4'], ['python3 place_order.py', 'L4'],
        ['find . -delete', 'L4'], ['frobnicate --all', 'L4'], ['ls && frobnicate', 'L4'],
    ];
    // stream redirections are not part of the command; read-only cloud CLIs are L0 unless they reach for secrets
    cases.push(['aws --version 2>&1', 'L0'], ['node --version 2>/dev/null', 'L0'], ['ls >&2', 'L0'], ['git status 2>&1 | head', 'L0'],
        ["/bin/bash -lc 'aws dynamodb list-tables --region ap-northeast-1 --query TableNames --output json --no-cli-pager'", 'L0'], ['aws sts get-caller-identity', 'L0'], ['aws s3 ls s3://bucket/', 'L0'], ['aws ec2 describe-instances --output table', 'L0'],
        ['kubectl get pods -A', 'L0'], ['gh pr list', 'L0'], ['gcloud compute instances list', 'L0'],
        ['aws secretsmanager get-secret-value --secret-id x', 'L4'], ['aws ssm get-parameter --name x --with-decryption', 'L4'], ['aws ecr get-login-password', 'L4'], ['aws sts get-session-token', 'L4'], ['aws s3api get-object --bucket b --key k out', 'L4'],
        ['aws dynamodb delete-table --table-name x', 'L4'], ['kubectl get secret db -o yaml', 'L4'], ['kubectl delete pod x', 'L4'], ['echo x; env | grep -o "^AWS[^=]*"', 'L4']);
    for (const [cmd, want] of cases) assert.equal(level(cmd), want, cmd);
    assert.equal(level('ls', [], [], 'CodexBash'), 'L0');
});
test('policy: file edits depend on the path; secrets stay L4; web, read and unknown tools have fixed levels', () => {
    assert.equal(level(JSON.stringify({ file_path: `${cwd}/src/a.ts`, old_string: 'a' }), [], [], 'Edit'), 'L1');
    assert.equal(level(JSON.stringify({ file_path: '/etc/hosts' }), [], [], 'Write'), 'L3');
    assert.equal(level(JSON.stringify({ file_path: `${cwd}/.env` }), [], [], 'Write'), 'L4');
    assert.equal(level('*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** End Patch', [], [], 'apply_patch'), 'L1');
    assert.equal(level('{}', [], [], 'Edit'), 'L4');
    assert.equal(level('https://docs.example.com', [], [], 'WebFetch'), 'L2');
    assert.equal(level(JSON.stringify({ file_path: '/var/log/syslog' }), [], [], 'Read'), 'L0');
    assert.equal(level(JSON.stringify({ file_path: `${cwd}/.env` }), [], [], 'Read'), 'L4');
    assert.equal(level('{"x":1}', [], [], 'mcp__trader__send'), 'L4');
});
test('policy: owner rules can raise or lower a command, never below L4 for a secret unless that rule is switched off', () => {
    const strategy: PolicyRule = { id: 'strategy', level: 'L4', pattern: '^python3 /home/ubuntu/strategy/' };
    assert.equal(level('python3 /home/ubuntu/strategy/run.py', [strategy]), 'L4');
    assert.equal(level('python3 /home/ubuntu/tools/report.py', [strategy]), 'L2');
    assert.equal(level('curl -s https://api.binance.com/api/v3/time', [{ id: 'exchange-time', level: 'L0', pattern: String.raw`^curl -s https://api\.binance\.com/api/v3/time$` }]), 'L0');
    assert.equal(level('cat .env', [{ id: 'cat-anything', level: 'L0', pattern: '^cat ' }]), 'L4');
    assert.equal(level('cat .env', [], ['secret']), 'L0');
    const c = classifyRequest({ tool: 'Bash', detail: 'ls && systemctl restart x' }, cwd, { rules: [] });
    assert.equal(c.ruleId, 'service'); assert.match(c.reason, /systemctl restart x/);
});
test('policy: owner rules are validated; command splitting respects quotes; paths resolve against the checkout', () => {
    for (const bad of [[{ id: 'x', level: 'L9', pattern: 'a' }], [{ id: 'x', level: 'L1', pattern: '(' }], [{ id: 'x', level: 'L1', pattern: '.*' }], [{ id: 'secret', level: 'L0', pattern: 'a' }], [{ id: 'Bad Id', level: 'L1', pattern: 'a' }], [{ id: 'a', level: 'L1', pattern: 'a' }, { id: 'a', level: 'L2', pattern: 'b' }]])
        assert.throws(() => checkRules(bad), JSON.stringify(bad));
    assert.deepEqual(checkRules([{ id: 'ok', level: 'L2', pattern: '^make deploy$', note: 'deploy' }]), [{ id: 'ok', level: 'L2', pattern: '^make deploy$', note: 'deploy' }]);
    assert.deepEqual(splitCommand('echo "a; b" && ls | wc -l').parts, ['echo "a; b"', 'ls', 'wc -l']);
    assert.deepEqual(splitCommand('cat x > out.txt 2>&1').redirects, ['out.txt']);
    assert.equal(resolvePath('~/psr-joint/../x', cwd), '/home/agent/x');
    assert.equal(resolvePath('sub/../a', cwd), `${cwd}/a`);
});
