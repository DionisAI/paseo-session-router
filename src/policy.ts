/** Permission levels: how dangerous one requested action is, decided by owner-editable rules over the exact command or file
 * path a session asks to use. The Router applies them in code; no model decides. Anything the rules do not recognise is L4,
 * a chained command counts as its most dangerous step, and nothing an owner rule says can hide a secret (L4) from view. */
import type { PermissionRequest } from './types.js';

export type Level = 'L0' | 'L1' | 'L2' | 'L3' | 'L4';
export const LEVELS: readonly Level[] = ['L0', 'L1', 'L2', 'L3', 'L4'];
export const LEVEL_INFO: Record<Level, { name: string; description: string }> = {
    L0: { name: '只讀', description: '只看不改：列目錄、讀一般檔案、查版本、看狀態和日誌' },
    L1: { name: '工作區內修改', description: '只改這個 session 自己目錄裡的檔案' },
    L2: { name: '安裝和執行', description: '安裝套件、跑腳本和程式、下載、刪工作區內的檔案' },
    L3: { name: '服務和系統', description: '重啟或停止服務、結束程序、sudo、改工作目錄以外的檔案' },
    L4: { name: '交易和機密', description: '下單、改策略、啟停交易程式、讀憑證和金鑰；認不出來的動作也算這一級' },
};
/** Who besides the owner may answer a request of a level. The owner (admin) always may; L4 is the owner's alone. */
export type Approver = 'planner' | 'frontend';
export const APPROVERS: readonly Approver[] = ['planner', 'frontend'];
export const DEFAULT_APPROVERS: Record<Level, Approver[]> = { L0: ['planner'], L1: ['planner'], L2: ['planner'], L3: [], L4: [] };
export interface PolicyRule { id: string; level: Level; pattern: string; note?: string }
export const rank = (l: Level) => LEVELS.indexOf(l);
const higher = (a: Level, b: Level): Level => rank(a) >= rank(b) ? a : b;

/** Credentials and keys anywhere in a command or path. Owner rules cannot lower it; only disabling the rule can. */
export const SECRET_RULE: PolicyRule = { id: 'secret', level: 'L4', pattern: String.raw`(^|[\s/'"=:*])\.env(\.|\b)|(^|[\s/'"=:*,])(?!(process|import\.meta|self|this|ctx|c|context|deno|bun|rails|mix)\.env\b)[\w.\u0080-￿-]*[\w\u0080-￿-]\.env(?=$|[\s'",])|\bid_(rsa|ed25519|ecdsa|dsa)\b|\.(pem|key|p12|pfx|keystore)\b|\.ssh(/|\b)|\.aws(/|\b)|\.gnupg(/|\b)|\.netrc\b|\.npmrc\b|\.pypirc\b|\bcredentials?\b|\bsecrets?\b|\bapi[_-]?keys?\b|\bprivate[_-]?keys?\b|\bpasswords?\b|(?<!(^|[\s/'"=:])(locales?|i18n|lang|translations?|messages)/[a-z]{2}([-_][a-z0-9]{2,4})?/)\bauth\.json\b|keypair[\w.-]*\.json\b|(^|[^A-Za-z0-9])keys?\.(json|toml|ya?ml)\b|(^|[^A-Za-z0-9])token\.(json|pickle)\b|\.pgpass\b|\.envrc\b|\.envs/|\.dev\.vars\b|\.tfstate\b|\.tfvars\b|\.htpasswd\b|\.jks\b|service[_-]?account[\w.-]*\.json\b|/proc/[^\s'"]*/(environ|cmdline|mem)\b|^(printenv|env|export -p|set)$`, note: '憑證、金鑰、環境變數' };
const SECRET_RE = new RegExp(SECRET_RULE.pattern, 'i');
/** The secret rule on the text and on its compatibility form: a case-insensitive file system (macOS) opens .ſſh/id_rſa (U+017F)
 * or server.Key (U+212A) as the real .ssh/id_rsa and server.key. */
export const isSecret = (text: string) => SECRET_RE.test(text) || SECRET_RE.test(text.normalize('NFKC'));
/** Built-in rules, matched against one simple command with wrappers (sudo, timeout, env …) removed. */
export const BUILTIN_RULES: readonly PolicyRule[] = [
    SECRET_RULE,
    { id: 'trading', level: 'L4', pattern: String.raw`\b(place|submit|create|cancel|amend|replace)_?orders?\b|\bwithdraw(al)?s?\b|\btransfer_funds\b|\bset_?leverage\b|\bclose_?(all_)?positions?\b|\bkill_?switch\b|\bflatten\b`, note: '下單、撤單、出金、改槓桿' },
    { id: 'read-basic', level: 'L0', pattern: String.raw`^(ls|ll|la|pwd|whoami|id|hostname|uname|date|uptime|which|type|whereis|file|stat|wc|du|df|free|nproc|lscpu|lsblk|echo|printf|true|false|sleep|basename|dirname|realpath|readlink|tree|cd|test|\[)(\s|$)`, note: '列目錄、看系統資訊' },
    { id: 'read-text', level: 'L0', pattern: String.raw`^(cat|head|tail|less|more|grep|egrep|fgrep|rg|ag|sort|uniq|cut|tr|awk|jq|yq|diff|cmp|md5sum|sha1sum|sha256sum|column|nl|od|xxd|strings|zcat|zgrep)(\s|$)|^sed\s+-n(\s|$)`, note: '讀檔、搜尋、比對' },
    { id: 'read-find', level: 'L0', pattern: String.raw`^find\s(?!.*\s-(exec|execdir|delete|ok|okdir|fprint|fprintf|fls)\b)`, note: 'find（不帶 -exec / -delete）' },
    { id: 'read-process', level: 'L0', pattern: String.raw`^(ps|pgrep|ss|netstat|lsof|ifconfig|dig|nslookup|host|vmstat|iostat|top\s+-b|ip\s+(-\w+\s+)*(a|addr|address|route|link|r)(\s+show)?(\s|$)|ping\s+-c)(\s|$)`, note: '程序、網路狀態' },
    { id: 'read-version', level: 'L0', pattern: String.raw`^\S+\s+(--version|-v|-V|version)\s*$|^(nvm\s+(ls|list|current|which|version|ls-remote)|npm\s+(ls|list|view|outdated|config\s+get|root|prefix|-v)|pip3?\s+(list|show|freeze)|uv\s+pip\s+(list|show)|python3?\s+-V|node\s+-p\s+process\.versions)(\s|$)`, note: '查版本、列已安裝套件' },
    { id: 'read-git', level: 'L0', pattern: String.raw`^git\s+(status|log|diff|show|branch|rev-parse|ls-files|blame|describe|shortlog|remote(\s+-v)?|config\s+--get|tag(\s+-l)?)(\s|$)`, note: 'git 查看' },
    { id: 'read-service', level: 'L0', pattern: String.raw`^(systemctl(\s+--user)?\s+(status|is-active|is-enabled|is-failed|list-units|list-unit-files|list-timers|show|cat)|journalctl|docker\s+(ps|logs|images|inspect|version|info|system\s+df|stats\s+--no-stream)|docker\s+compose\s+(ps|logs|config|ls)|crontab\s+-l|tmux\s+(ls|list-sessions)|apt(-cache)?\s+(list|show|policy|search)|dpkg\s+(-l|-s|-L|--list|--status)|pm2\s+(ls|list|status|logs))(\s|$)`, note: '看服務、容器、日誌' },
    { id: 'read-cloud', level: 'L0', pattern: String.raw`^(aws\s+(--version|sts\s+get-caller-identity|configure\s+list(-profiles)?|s3\s+ls|[a-z0-9-]+\s+(list-|describe-|get-(?!object)|search-|lookup-|batch-get-|head-)(?![^\s]*(secret|password|credential|login|token|decrypt|private))\S*(?!.*--with-decryption))|kubectl\s+(get|describe|logs|top|version|api-resources|explain|config\s+(view|get-contexts|current-context))|gcloud\s+((\S+\s+)+(list|describe)|config\s+list|auth\s+list|version|--version)|az\s+((\S+\s+)+(list|show)|account\s+show|version)|gh\s+((pr|issue|run|repo|release|workflow)\s+(list|view|status|diff|checks)|auth\s+status))(\s|$)`, note: '雲端與叢集的只讀查詢（AWS、kubectl、gcloud、az、gh）' },
    { id: 'workspace-git', level: 'L1', pattern: String.raw`^git\s+(add|commit|checkout|switch|restore|stash|merge|rebase|reset|pull|fetch|init|mv|rm|tag\s+\S)(\s|$)`, note: 'git 在工作區內的操作' },
    { id: 'install', level: 'L2', pattern: String.raw`^(pip3?\s+(install|uninstall|download)|uv\s+(pip\s+install|add|remove|sync|tool\s+install|venv)|npm\s+(i|install|ci|update|uninstall|link|exec)|npx|pnpm|yarn|bun\s+(add|install)|cargo\s+(install|build|add)|go\s+(install|get|build)|nvm\s+(install|use|alias|uninstall|unalias)|corepack|gem\s+install|brew\s+install|conda\s+install)(\s|$)`, note: '安裝、升級套件' },
    { id: 'run-code', level: 'L2', pattern: String.raw`^(python3?|node|deno|bun|ruby|perl|php|bash|sh|zsh|uv\s+run|poetry\s+run|make|cmake|pytest|jupyter|ipython|npm\s+(run|test|start)|yarn\s+(run|test)|cargo\s+(run|test)|go\s+(run|test)|java|\.\/\S+)(?!\s+(--version|-v|-V|version|-p\s+process\.versions)\s*$)(\s|$)`, note: '跑腳本和程式' },
    { id: 'network', level: 'L2', pattern: String.raw`^(curl|wget|git\s+(clone|push)|scp|rsync|ssh|sftp|ftp|nc|telnet|http)(\s|$)`, note: '下載、上傳、連到別的機器' },
    { id: 'container', level: 'L2', pattern: String.raw`^docker\s+(run|exec|build|pull|create|start|cp|compose\s+(up|run|build|pull|exec))(\s|$)`, note: '起容器、在容器裡執行' },
    { id: 'service', level: 'L3', pattern: String.raw`^(systemctl(\s+--user)?\s+(start|stop|restart|reload|enable|disable|mask|unmask|kill|daemon-reload|edit)|service\s+\S+\s+(start|stop|restart|reload)|kill|pkill|killall|reboot|shutdown|halt|poweroff|crontab|chmod|chown|chgrp|useradd|usermod|userdel|passwd|ufw|iptables|nft|mount|umount|dd|mkfs\S*|fdisk|parted|swapon|swapoff|sysctl|modprobe|docker\s+(stop|restart|rm|rmi|kill|system\s+prune|volume\s+rm|network\s+rm|compose\s+(down|restart|stop|rm))|pm2\s+(start|stop|restart|delete|reload|kill)|supervisorctl\s+(start|stop|restart|reload|update)|tmux\s+kill-\S+|apt(-get)?\s+(install|upgrade|full-upgrade|dist-upgrade|update|remove|purge|autoremove)|snap\s+(install|remove|refresh))(\s|$)`, note: '服務、程序、系統設定' },
];
/** Commands whose effect is writing the paths they name: inside the session's checkout they are workspace edits, anywhere else
 * they change the machine. Deleting is one level up from editing. */
const WRITE_COMMAND = /^(mkdir|touch|cp|mv|ln|rm|rmdir|tee|truncate|unzip|tar|sed\s+(-\w*i|--in-place))(\s|$)/;
export const COMMAND_TOOL = /^(bash|codexbash|shell|local_shell|exec_command|run_command|run_shell_command|terminal|command)$/i;
export const EDIT_TOOL = /^(edit|write|multiedit|notebookedit|apply_patch|codexapplypatch|codexedit|str_replace_editor|create_file|edit_file|write_file|file_change|filechange)$/i;
export const READ_TOOL = /^(read|glob|grep|ls|view|read_file|list_dir|search)$/i;
const WEB_TOOL = /^(webfetch|websearch|web_search|fetch|browser)$/i;

export interface Verdict { level: Level; ruleId: string | null; text: string }
export interface Classification { level: Level; ruleId: string | null; reason: string; steps: Verdict[] }
export interface PolicyInput { rules: readonly PolicyRule[]; disabled?: readonly string[] }

/** Split a shell command into simple commands, with the bodies of $(…) and backticks, and the files it redirects output to.
 * Quote-aware but deliberately small; anything it cannot follow still ends up classified, and unknown means L4. */
export function splitCommand(cmd: string): { parts: string[]; nested: string[]; redirects: string[] } {
    const parts: string[] = [], nested: string[] = [], redirects: string[] = [];
    let cur = '', quote: '"' | "'" | null = null;
    const push = () => { if (cur.trim()) parts.push(cur.trim()); cur = ''; };
    for (let i = 0; i < cmd.length; i++) {
        const c = cmd[i], next = cmd[i + 1];
        if (quote === "'") { if (c === "'") quote = null; cur += c; continue; }
        if (c === '\\' && next !== undefined) { cur += c + next; i++; continue; }
        if (c === '$' && next === '(') {
            let depth = 1, j = i + 2;
            for (; j < cmd.length && depth; j++) { if (cmd[j] === '(') depth++; else if (cmd[j] === ')') depth--; }
            nested.push(cmd.slice(i + 2, j - 1)); cur += '$(…)'; i = j - 1; continue;
        }
        if (c === '`') { const j = cmd.indexOf('`', i + 1), end = j < 0 ? cmd.length : j; nested.push(cmd.slice(i + 1, end)); cur += '`…`'; i = end; continue; }
        if (quote === '"') { if (c === '"') quote = null; cur += c; continue; }
        if (c === '"' || c === "'") { quote = c; cur += c; continue; }
        if (c === '<' && next === '(') { let depth = 1, j = i + 2; for (; j < cmd.length && depth; j++) { if (cmd[j] === '(') depth++; else if (cmd[j] === ')') depth--; } nested.push(cmd.slice(i + 2, j - 1)); cur += '<(…)'; i = j - 1; continue; }
        if (c === '>' ) {
            cur = cur.replace(/(^|\s)\d+$/, '$1'); // the 2 of 2>file belongs to the redirection, not to the command
            // >&2, 2>&1: a stream, not a file
            if (next === '&') { let j = i + 2; while (/[\d-]/.test(cmd[j] ?? '')) j++; cur += ' '; i = j - 1; continue; }
            let j = i + 1; if (cmd[j] === '>' || cmd[j] === '|') j++;
            while (cmd[j] === ' ' || cmd[j] === '\t') j++;
            let target = '', q: string | null = null;
            for (; j < cmd.length; j++) { const d = cmd[j]; if (q) { if (d === q) { q = null; continue; } target += d; continue; } if (d === '"' || d === "'") { q = d; continue; } if (/[\s;&|<>()]/.test(d)) break; target += d; }
            if (target) redirects.push(target);
            cur += ' '; i = j - 1; continue;
        }
        if (c === ';' || c === '\n' || c === '|' || c === '&') { if ((c === '|' || c === '&') && next === c) i++; push(); continue; }
        cur += c;
    }
    push();
    return { parts, nested, redirects };
}
const unquote = (s: string) => s.replace(/^(['"])([\s\S]*)\1$/, '$2');
/** Remove what only changes how a command runs (env assignments, sudo, timeout, nohup …); report sudo. */
function core(part: string): { text: string; sudo: boolean; inner: string | null } {
    let text = part.trim(), sudo = false;
    for (let guard = 0; guard < 12; guard++) {
        const before = text;
        text = text.replace(/^([A-Za-z_][A-Za-z0-9_]*=("[^"]*"|'[^']*'|\S*)\s+)+/, '');
        if (/^sudo(\s|$)/.test(text)) { sudo = true; text = text.replace(/^sudo(\s+-\S+(\s+(?!-)\S+)?)*\s*/, ''); }
        text = text.replace(/^(timeout\s+(-\S+\s+)*\S+|nice(\s+-n\s*-?\d+|\s+-\d+)?|ionice(\s+-\S+)*|nohup|time|command|exec|builtin|stdbuf(\s+-\S+)*|env(\s+-\S+)*|xargs(\s+-\S+(\s+(?!-)\S+)?)*)\s+/, '');
        if (text === before) break;
    }
    // bash -c '…', sh -lc "…", and Codex's unquoted bash -lc …: classify the script itself
    const m = text.match(/^(?:\/\S*\/)?(?:ba|z|da)?sh\s+(?:-\w*\s+)*-\w*c\w*\s+([\s\S]+)$/);
    return { text, sudo, inner: m ? unquote(m[1].trim()) : null };
}
/** Where a path points, resolved against the session's checkout; ~ is the home directory the checkout lives in. */
export function resolvePath(p: string, cwd: string | null): string | null {
    let s = unquote(p.trim()); if (!s) return null;
    const home = cwd?.match(/^(\/home\/[^/]+|\/Users\/[^/]+|\/root)(\/|$)/)?.[1] ?? null;
    if (s === '~' || s.startsWith('~/') || s.startsWith('$HOME')) { if (!home) return null; s = home + s.replace(/^(~|\$HOME)/, ''); }
    else if (!s.startsWith('/')) { if (!cwd) return null; s = cwd + '/' + s; }
    const out: string[] = [];
    for (const seg of s.split('/')) { if (!seg || seg === '.') continue; if (seg === '..') out.pop(); else out.push(seg); }
    return '/' + out.join('/');
}
export const inside = (path: string | null, cwd: string | null) => !!path && !!cwd && (path === cwd || path.startsWith(cwd.replace(/\/$/, '') + '/'));
const isStream = (t: string) => /^\/dev\/(null|stdout|stderr|tty|fd\/\d)$/.test(t);

export function classifyRequest(r: Pick<PermissionRequest, 'tool' | 'detail'>, cwd: string | null, policy: PolicyInput): Classification {
    const rules = [...BUILTIN_RULES, ...policy.rules.map(x => ({ ...x, custom: true }))].filter(x => !policy.disabled?.includes(x.id));
    const tool = String(r.tool ?? ''), detail = String(r.detail ?? '');
    const secret = (text: string): Verdict | null => rules.some(x => x.id === SECRET_RULE.id) && isSecret(text) ? { level: 'L4', ruleId: SECRET_RULE.id, text } : null;
    const writeTo = (target: string, dir: string | null = cwd): Verdict => { const path = resolvePath(target, dir); return secret(path ?? target) ?? { level: inside(path, cwd) ? 'L1' : 'L3', ruleId: inside(path, cwd) ? 'workspace-write' : 'outside-write', text: target }; };
    const finish = (steps: Verdict[], fallback: string): Classification => {
        const top = steps.reduce<Verdict | null>((a, b) => !a || rank(b.level) > rank(a.level) ? b : a, null) ?? { level: 'L4' as Level, ruleId: null, text: detail };
        return { level: top.level, ruleId: top.ruleId, reason: top.ruleId ? `${top.ruleId}: ${top.text}`.slice(0, 300) : fallback, steps };
    };
    // Owner rules can name any tool: they match "tool detail" as well as the bare command.
    const ownerMatch = (text: string) => rules.filter(x => (x as { custom?: boolean }).custom && new RegExp(x.pattern, 'i').test(text));
    const own = ownerMatch(`${tool} ${detail}`.trim());
    if (COMMAND_TOOL.test(tool) || /bash|shell/i.test(tool)) {
        const steps = classifyCommand(detail, { dir: cwd }, rules, writeTo, 0);
        return finish(steps, '認不出的命令');
    }
    const extra: Verdict[] = own.length ? [{ level: own.reduce<Level>((l, x) => higher(l, x.level), 'L0'), ruleId: own[0].id, text: `${tool} ${detail}`.trim() }] : [];
    if (EDIT_TOOL.test(tool)) {
        const paths = [...detail.matchAll(/"(?:file_path|filePath|path|notebook_path|target_file|file)"\s*:\s*"((?:[^"\\]|\\.)+)"/g)].map(m => m[1]).concat([...detail.matchAll(/^\*\*\* (?:Add|Update|Delete|Move to) File:\s*(.+)$/gm)].map(m => m[1].trim()));
        if (!paths.length) return finish(extra, '改檔案，但看不出是哪個檔案');
        // an owner rule sets the level of the files it names, except that a secret stays L4
        return finish(paths.map(path => { const v = writeTo(path); return extra.length && v.ruleId !== SECRET_RULE.id ? { ...extra[0], text: path } : v; }), '');
    }
    const sec = secret(detail);
    if (sec) return finish([sec], '');
    if (extra.length) return finish(extra, '');
    if (READ_TOOL.test(tool)) return finish([{ level: 'L0', ruleId: 'read-tool', text: tool }], '');
    if (WEB_TOOL.test(tool)) return finish([{ level: 'L2', ruleId: 'web-tool', text: `${tool} ${detail}`.trim() }], '');
    return finish([], `認不出的工具：${tool}`);
}
/** at.dir follows cd within one command line, so a relative path after `cd /etc &&` is judged where it really points. */
function classifyCommand(cmd: string, at: { dir: string | null }, rules: (PolicyRule & { custom?: boolean })[], writeTo: (t: string, dir?: string | null) => Verdict, depth: number): Verdict[] {
    if (depth > 4) return [{ level: 'L4', ruleId: null, text: cmd }];
    const { parts, nested, redirects } = splitCommand(cmd), steps: Verdict[] = [];
    for (const n of nested) steps.push(...classifyCommand(n, at, rules, writeTo, depth + 1));
    for (const t of redirects) if (!isStream(t)) steps.push(writeTo(t, at.dir));
    for (const part of parts) {
        const { text, sudo, inner } = core(part);
        if (inner !== null) { steps.push(...classifyCommand(inner, at, rules, writeTo, depth + 1)); if (sudo) steps.push({ level: 'L3', ruleId: 'sudo', text: part }); continue; }
        const cd = text.match(/^(cd|pushd)(\s+(\S+))?\s*$/);
        if (cd) at.dir = cd[3] && cd[3] !== '-' ? resolvePath(cd[3], at.dir) : null;
        const matches = (custom: boolean) => rules.filter(x => !!(x as { custom?: boolean }).custom === custom && x.id !== SECRET_RULE.id && new RegExp(x.pattern, 'i').test(text));
        const owner = matches(true), builtin = matches(false);
        let v: Verdict | null = null;
        if (owner.length) { const top = owner.reduce((a, b) => rank(b.level) > rank(a.level) ? b : a); v = { level: top.level, ruleId: top.id, text }; }
        else if (WRITE_COMMAND.test(text)) {
            const args = text.split(/\s+/).slice(1).filter(a => a && !a.startsWith('-') && !/^s[/|#]/.test(a) && !/^\d+$/.test(a));
            const targets = args.map(a => writeTo(a, at.dir)), worst = targets.reduce<Verdict | null>((a, b) => !a || rank(b.level) > rank(a.level) ? b : a, null);
            const deleting = /^(rm|rmdir|truncate)(\s|$)/.test(text);
            v = worst && worst.level !== 'L1' ? worst : { level: deleting ? 'L2' : 'L1', ruleId: deleting ? 'workspace-delete' : 'workspace-write', text };
        }
        else if (builtin.length) { const top = builtin.reduce((a, b) => rank(b.level) > rank(a.level) ? b : a); v = { level: top.level, ruleId: top.id, text }; }
        steps.push(v ?? { level: 'L4', ruleId: null, text });
        const sec = rules.some(x => x.id === SECRET_RULE.id) && isSecret(text);
        if (sec) steps.push({ level: 'L4', ruleId: SECRET_RULE.id, text });
        if (sudo) steps.push({ level: 'L3', ruleId: 'sudo', text: part });
    }
    return steps;
}
/** Check owner rules before storing them: a valid level, a pattern that compiles and is not catastrophically broad. */
export function checkRules(rules: unknown): PolicyRule[] {
    if (!Array.isArray(rules) || rules.length > 200) throw new Error('rules: at most 200');
    const ids = new Set<string>();
    return rules.map((x, i) => {
        const r = x as PolicyRule;
        if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,39}$/.test(r.id) || ids.has(r.id) || BUILTIN_RULES.some(b => b.id === r.id)) throw new Error(`rules[${i}].id: 1–40 of a-z 0-9 _ -, unique, not a built-in id`);
        if (!LEVELS.includes(r.level)) throw new Error(`rules[${i}].level must be L0..L4`);
        if (typeof r.pattern !== 'string' || !r.pattern.trim() || r.pattern.length > 500) throw new Error(`rules[${i}].pattern: 1–500 characters`);
        try { new RegExp(r.pattern, 'i'); } catch { throw new Error(`rules[${i}].pattern is not a valid regular expression`); }
        if (new RegExp(r.pattern, 'i').test('') ) throw new Error(`rules[${i}].pattern matches everything`);
        if (r.note !== undefined && (typeof r.note !== 'string' || r.note.length > 120)) throw new Error(`rules[${i}].note ≤120 characters`);
        ids.add(r.id);
        return { id: r.id, level: r.level, pattern: r.pattern, ...(r.note ? { note: r.note } : {}) };
    });
}
