import { spawnSync } from 'node:child_process';
import { isPidAlive } from '../observability/fs-atomic.js';
export function queryProcessTable() {
    if (process.platform === 'win32') {
        const psScript = 'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate | ' +
            'Select-Object ProcessId,ParentProcessId,' +
            "@{Name='CreationDate';Expression={if ($_.CreationDate) { $_.CreationDate.ToString('o') } else { 'unknown' }}} | " +
            'ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.CreationDate)" }';
        try {
            const res = spawnSync('powershell', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', psScript], { encoding: 'utf8', timeout: 8000, windowsHide: true });
            if (res.status === 0 && res.stdout) {
                return res.stdout
                    .split(/\r?\n/)
                    .map((l) => l.trim())
                    .filter(Boolean)
                    .flatMap((line) => {
                    const [p, pp, born] = line.split('\t');
                    const pid = Number(p);
                    const parent = Number(pp);
                    return Number.isInteger(pid) && pid > 0
                        ? [{ pid, parent: Number.isInteger(parent) ? parent : 0, born: born || 'unknown' }]
                        : [];
                });
            }
        }
        catch { }
        return null;
    }
    try {
        const res = spawnSync('ps', ['-axo', 'pid=,ppid=,lstart='], {
            encoding: 'utf8',
            timeout: 3000,
            env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
        });
        if (res.status === 0 && res.stdout) {
            return res.stdout
                .split('\n')
                .map((l) => l.trim())
                .filter(Boolean)
                .flatMap((line) => {
                const m = /^(\d+)\s+(\d+)\s+(.+)$/.exec(line);
                return m ? [{ pid: Number(m[1]), parent: Number(m[2]), born: m[3].trim() }] : [];
            });
        }
    }
    catch { }
    return null;
}
export function captureProcessIdentity(pid) {
    if (!Number.isInteger(pid) || pid <= 1)
        return null;
    if (process.platform === 'win32') {
        const psSingle = `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; ` +
            `if ($p -and $p.StartTime) { $p.StartTime.ToUniversalTime().ToString('o') }`;
        try {
            const res = spawnSync('powershell', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', psSingle], { encoding: 'utf8', timeout: 2500, windowsHide: true });
            const born = res.status === 0 ? res.stdout.trim() : '';
            return { pid: pid, born: born || 'unknown' };
        }
        catch {
            return { pid: pid, born: 'unknown' };
        }
    }
    const rows = queryProcessTable();
    const row = rows?.find((r) => r.pid === pid);
    return row ? { pid: row.pid, born: row.born } : { pid: pid, born: 'unknown' };
}
export function isProcessIdentityAlive(identity, verifyBorn = false) {
    if (!identity || !isPidAlive(identity.pid))
        return false;
    if (!verifyBorn || !identity.born || identity.born === 'unknown')
        return true;
    if (process.platform === 'win32') {
        const current = captureProcessIdentity(identity.pid);
        if (!current)
            return false;
        return current.born === 'unknown' || current.born === identity.born;
    }
    const rows = queryProcessTable();
    if (!rows)
        return true;
    const row = rows.find((r) => r.pid === identity.pid);
    if (!row)
        return false;
    return row.born === 'unknown' || row.born === identity.born;
}
export async function terminateProcessTree(pid) {
    if (!Number.isInteger(pid) || pid <= 1)
        return;
    const rootPid = pid;
    if (process.platform === 'win32') {
        try {
            spawnSync('taskkill', ['/PID', String(rootPid), '/T', '/F'], {
                windowsHide: true,
                stdio: 'ignore',
                timeout: 8000,
            });
        }
        catch { }
        try {
            if (isPidAlive(rootPid))
                process.kill(rootPid);
        }
        catch { }
        return;
    }
    const rows = queryProcessTable() ?? [];
    const descendants = new Set([rootPid]);
    for (let changed = true; changed;) {
        changed = false;
        for (const r of rows) {
            if (!descendants.has(r.pid) && descendants.has(r.parent) && r.pid !== process.pid) {
                descendants.add(r.pid);
                changed = true;
            }
        }
    }
    try {
        process.kill(-rootPid, 'SIGTERM');
    }
    catch { }
    for (const target of [...descendants].reverse()) {
        try {
            process.kill(target, 'SIGTERM');
        }
        catch { }
    }
    await new Promise((r) => setTimeout(r, 350));
    try {
        process.kill(-rootPid, 'SIGKILL');
    }
    catch { }
    for (const target of [...descendants].reverse()) {
        try {
            if (isPidAlive(target))
                process.kill(target, 'SIGKILL');
        }
        catch { }
    }
}
