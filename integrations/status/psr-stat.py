#!/usr/bin/env python3
"""psr-stat: tells the Paseo Session Router how this machine is doing, once a minute, so that its console can show it.

What it sends (POST <router>/local/stat), and nothing else:
  cpus, cpuPct   number of CPUs and how busy they were since the last report
  load           load averages (1, 5, 15 minutes)
  memory, swap   total and available memory, total and used swap, in MB
  disks          for each local disk: where it is mounted, its size and free space, in MB
  uptimeSec      seconds since the machine started
No process list, no file names, no host name, no addresses, no file contents. See it for yourself, without sending:
  python3 psr-stat.py --once --print

It reads ~/.config/psr/stat.json ({"url": "https://<router>"}) and ~/.config/psr/stat.token (a status credential, psrs_...,
which can report this machine's figures and do nothing else). It takes no commands from the Router: the answer to a report
is read only as accepted or refused. Its credential goes to that one address and nowhere else: over https (http only to this
machine itself), straight (no proxy), and a redirect is never followed. It writes no files. Python 3.6 or newer, standard
library only; Linux and macOS.

  psr-stat.py              report every 60 seconds until stopped (what the installed service runs)
  psr-stat.py --once       one report, then exit (0 sent, 2 not configured, 3 refused, 4 Router not reached)
  psr-stat.py --once --print   print what would be sent; nothing is sent, no configuration is needed
"""
import json, os, re, subprocess, sys, threading, time, urllib.error, urllib.request

INTERVAL = 60
CONF = os.path.join(os.path.expanduser('~'), '.config', 'psr')
MB = 1024 * 1024
MOUNT_OK = re.compile(r'^/(?:[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*)?$')
MOUNT_MAX = 64
# the Router's address: a host and maybe a port, nothing else (no path, no user, no query)
ROUTER_OK = re.compile(r'^(https://[A-Za-z0-9.-]+(:\d+)?|http://(127\.0\.0\.1|localhost)(:\d+)?)$')
# one round of measuring and sending never takes longer than this: past it the reporter ends and its service starts it again
DEADLINE = 120
# the Router's own refusal of the credential, this many times in a row, a few seconds apart: then it is final
REFUSALS, RETRY = 3, 3
# local file systems only: a network mount can hang, and pseudo file systems are not disks
LOCAL_FS = {'ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'zfs', 'f2fs', 'jfs', 'reiserfs', 'bcachefs'}
SKIP_UNDER = ('/boot', '/snap', '/run', '/sys', '/proc', '/dev', '/var/lib/docker', '/var/lib/containers', '/var/lib/kubelet', '/var/snap')
DISKS_MAX = 16
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # the credential is for the address it was given to: a redirect is an error, never followed


# straight to the Router: a proxy set for this system or in the environment is for other traffic
DIRECT = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())


def say(text):
    sys.stderr.write('psr-stat: %s\n' % text)
    sys.stderr.flush()


def out(args):
    return subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=10, universal_newlines=True).stdout


def disk(mount, path=None):
    """One disk as the report names it, or None when it cannot be read or is too small to matter."""
    try:
        s = os.statvfs(path or mount)
    except OSError:
        return None
    # as df counts it: the space in use plus the space a user may still fill (blocks kept back for root are in neither)
    free = s.f_bavail * s.f_frsize // MB
    total = (s.f_blocks - s.f_bfree) * s.f_frsize // MB + free
    if total < 256:
        return None
    return {'mount': mount, 'totalMb': total, 'availableMb': min(free, total)}


def plain(mount):
    """A mount point in the characters a report may carry: anything else becomes _ (a name with a space, say)."""
    name = '/' + '/'.join(re.sub(r'[^A-Za-z0-9_.-]', '_', part) for part in mount.split('/') if part not in ('', '.', '..'))
    return name if len(name) <= MOUNT_MAX and MOUNT_OK.match(name) else None


# ---------- Linux ----------
def linux_cpu_times():
    with open('/proc/stat') as f:
        v = [int(x) for x in f.readline().split()[1:9]]
    return sum(v), v[3] + v[4]  # all, idle + iowait


def linux_report(cpu_pct):
    info = {}
    with open('/proc/meminfo') as f:
        for line in f:
            k, _, rest = line.partition(':')
            info[k] = int(rest.split()[0])  # kB
    available = info.get('MemAvailable', info.get('MemFree', 0) + info.get('Buffers', 0) + info.get('Cached', 0))
    swap_total = info.get('SwapTotal', 0)
    seen, disks = set(), []
    with open('/proc/self/mounts') as f:
        mounts = [line.split()[:3] for line in f if len(line.split()) >= 3]
    for device, mount, fstype in sorted(mounts, key=lambda m: (m[1] != '/', len(m[1]), m[1])):
        mount = mount.replace('\\040', ' ')
        # the root always (in a container it is an overlay over the host's disk); else local disks mounted on a folder
        # (a single file bound into a container is a mount too, and no disk)
        if mount != '/' and (fstype not in LOCAL_FS or not os.path.isdir(mount) or any(mount == p or mount.startswith(p + '/') for p in SKIP_UNDER)):
            continue
        if device in seen:
            continue
        name, d = plain(mount), None
        if name and not any(x['mount'] == name for x in disks):
            d = disk(name, mount)
        if d:
            seen.add(device)
            disks.append(d)
    with open('/proc/uptime') as f:
        uptime = int(float(f.read().split()[0]))
    return {'cpus': os.cpu_count() or 1, 'cpuPct': cpu_pct, 'load': list(os.getloadavg()),
            'memory': {'totalMb': info['MemTotal'] // 1024, 'availableMb': min(available, info['MemTotal']) // 1024},
            'swap': {'totalMb': swap_total // 1024, 'usedMb': max(0, swap_total - info.get('SwapFree', 0)) // 1024},
            'disks': disks[:DISKS_MAX], 'uptimeSec': uptime}


# ---------- macOS ----------
def mac_cpu_times():
    """CPU ticks since boot (all, idle) from the kernel's host statistics; None when that cannot be asked."""
    try:
        import ctypes, ctypes.util
        libc = ctypes.CDLL(ctypes.util.find_library('c'))
        libc.mach_host_self.restype = ctypes.c_uint
        ticks, count = (ctypes.c_uint * 4)(), ctypes.c_uint(4)
        if libc.host_statistics(libc.mach_host_self(), 3, ctypes.byref(ticks), ctypes.byref(count)) != 0:  # HOST_CPU_LOAD_INFO
            return None
        user, system, idle, nice = ticks
        return user + system + idle + nice, idle
    except Exception:
        return None


def mac_report(cpu_pct):
    total = int(out(['/usr/sbin/sysctl', '-n', 'hw.memsize']))
    vm = out(['/usr/bin/vm_stat'])
    page = int(re.search(r'page size of (\d+) bytes', vm).group(1))
    pages = {m.group(1): int(m.group(2)) for m in re.finditer(r'^(.+?):\s+(\d+)\.?$', vm, re.M)}
    # what can be handed out without swapping: free pages, cached files and pages the system keeps only speculatively
    available = (pages.get('Pages free', 0) + pages.get('Pages inactive', 0) + pages.get('Pages speculative', 0) + pages.get('Pages purgeable', 0)) * page
    swap = None
    m = re.search(r'total = ([\d.]+)([MG]).*?used = ([\d.]+)([MG])', out(['/usr/sbin/sysctl', '-n', 'vm.swapusage']))
    if m:
        to_mb = lambda n, unit: int(float(n) * (1024 if unit == 'G' else 1))
        swap = {'totalMb': to_mb(m.group(1), m.group(2)), 'usedMb': min(to_mb(m.group(3), m.group(4)), to_mb(m.group(1), m.group(2)))}
    boot = re.search(r'sec = (\d+)', out(['/usr/sbin/sysctl', '-n', 'kern.boottime']))
    # the startup disk only: its data volume is where the space goes; other volumes may ask the user for permission
    data = '/System/Volumes/Data'
    d = disk('/', data if os.path.isdir(data) else '/')
    return {'cpus': os.cpu_count() or 1, 'cpuPct': cpu_pct, 'load': list(os.getloadavg()),
            'memory': {'totalMb': total // MB, 'availableMb': min(available, total) // MB}, 'swap': swap,
            'disks': [d] if d else [], 'uptimeSec': max(0, int(time.time()) - int(boot.group(1))) if boot else None}


LINUX = sys.platform.startswith('linux')
cpu_times = linux_cpu_times if LINUX else mac_cpu_times


def busy(before, after):
    """Percent of CPU time not idle between two readings; None when either is missing or no time passed."""
    if not before or not after:
        return None
    total, idle = after[0] - before[0], after[1] - before[1]
    if not LINUX:  # the kernel's tick counters are 32 bits wide there and wrap around
        total, idle = total % 2 ** 32, idle % 2 ** 32
    if total <= 0:
        return None
    return round(max(0.0, min(100.0, 100.0 * (1 - idle / float(total)))), 1)


def measure(cpu_pct):
    r = linux_report(cpu_pct) if LINUX else mac_report(cpu_pct)
    r['load'] = [round(max(0.0, x), 2) for x in r['load']]
    return dict(v=1, **r)


def configured():
    """(url, token), or exits 2 saying what is missing. The Router is reached over https, or over http on this machine only."""
    try:
        with open(os.path.join(CONF, 'stat.json')) as f:
            url = str(json.load(f)['url']).rstrip('/')
        with open(os.path.join(CONF, 'stat.token')) as f:
            token = f.read().strip()
    except (OSError, ValueError, KeyError):
        say('not configured: %s needs stat.json and stat.token (run the installer)' % CONF)
        sys.exit(2)
    if not ROUTER_OK.match(url):
        say('the Router address must be https://<host>[:port] and nothing more (http only for 127.0.0.1 or localhost)')
        sys.exit(2)
    if not token.startswith('psrs_'):
        say('stat.token does not hold a status credential (psrs_...)')
        sys.exit(2)
    return url, token


def send(url, token, report):
    """'ok', 'refused' (the credential is revoked, replaced or expired), or a short reason the report did not arrive."""
    req = urllib.request.Request(url + '/local/stat', data=json.dumps(report).encode(), method='POST',
                                 headers={'authorization': 'Bearer ' + token, 'content-type': 'application/json'})
    try:
        with DIRECT.open(req, timeout=20) as r:
            r.read(4096)
        return 'ok'
    except urllib.error.HTTPError as e:
        refused = False
        if e.code == 401:  # the Router's own refusal says so in JSON; a sign-in page in between does not
            try:
                refused = json.loads(e.read(4096).decode('utf-8', 'replace')).get('code') == 'UNAUTHORIZED'
            except Exception:
                refused = False
        return 'refused' if refused else 'the Router answered %d' % e.code
    except Exception as e:  # no network, DNS, TLS, timeout: try again next time
        return 'the Router was not reached (%s)' % type(e).__name__


def within(seconds, fn, *args):
    """fn(*args), or the end of this process (exit 5) when it takes longer: a stuck disk or a connection that never ends
    must not leave a reporter that runs and reports nothing. Its service starts it again."""
    timer = threading.Timer(seconds, os._exit, (5,))
    timer.daemon = True
    timer.start()
    try:
        return fn(*args)
    finally:
        timer.cancel()


def main(argv):
    once, show = '--once' in argv, '--print' in argv
    if [a for a in argv if a not in ('--once', '--print')] or (show and not once):
        sys.stderr.write(__doc__)
        return 2
    if not LINUX and sys.platform != 'darwin':
        say('only Linux and macOS are measured')
        return 2
    before = cpu_times()
    if once:
        time.sleep(0.5)
        report = within(DEADLINE, measure, busy(before, cpu_times()))
        if show:
            print(json.dumps(report, indent=2))
            return 0
        url, token = configured()
        result = within(DEADLINE, send, url, token, report)
        if result != 'ok':
            say('the Router refused this credential: it was revoked, replaced or has expired' if result == 'refused' else result)
        return 0 if result == 'ok' else 3 if result == 'refused' else 4
    url, token = configured()
    last, refusals = None, 0
    while True:
        time.sleep(0.5 if last is None else RETRY if refusals else INTERVAL)
        now = cpu_times()
        try:
            result = within(DEADLINE, lambda: send(url, token, measure(busy(before, now))))
        except Exception as e:  # a reading that failed this once
            result = 'could not measure (%s)' % type(e).__name__
        before = now
        refusals = refusals + 1 if result == 'refused' else 0
        if refusals >= REFUSALS:
            # ending with success: the service manager does not start it again, and nothing is retried against a dead credential
            say('the Router refused this credential (revoked, replaced or expired): stopping. Install again for a new one.')
            return 0
        if result != last and result != 'refused':  # one line when it starts working, one when it stops: never a line a minute
            say('reporting to %s' % url if result == 'ok' else result)
        last = result


if __name__ == '__main__':
    try:
        sys.exit(main(sys.argv[1:]))
    except KeyboardInterrupt:
        sys.exit(0)
