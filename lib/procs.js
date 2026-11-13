/**
 * 进程枚举、强杀与「归属判定」。
 *
 * 为什么不能只靠 `taskkill /T`：
 * Git Bash（Cygwin）在 Windows 上没有真正的 exec，`exec npm run dev` 这类写法
 * 实际是「新建进程 + 旧进程退出」。脚本里的 exec 一旦执行，后续进程的 PPID
 * 就指向一个已经消失的 pid，进程树从那一刻断裂 —— `taskkill /PID <根> /T`
 * 只能看到根进程下面还连着的那一层，dev server 于是变成孤儿继续占着端口。
 *
 * 所以停止分两步：先打根进程树，再用证据清掉断链的那部分。证据要求同时满足：
 *   1. 该进程不在「启动前基线」里（即本次启动之后才出现）
 *   2. 创建时间不早于本次启动（留 2 秒时钟容差）
 *   3. 沿 PPID 上溯，要么能走到根进程；要么断在一个「本次启动期间才存在、
 *      现在已经消失」的 pid 上，并且该进程的命令行能对上启动项里的路径特征
 * 宁可少杀也不误杀：证据不足的进程只记日志、不动手。
 */

import { spawnSync } from 'node:child_process';

/** 启动时间与进程创建时间的时钟容差。 */
const CLOCK_SLACK = 2000;
/** 沿父链最多上溯多少层。 */
const WALK_LIMIT = 32;
/** 一轮清扫最多动多少进程，异常情况下宁可放弃。 */
const MAX_SWEEP = 32;
const MAX_BUFFER = 16 * 1024 * 1024;

/** 判断 pid 是否还活着（自己无权查也算活着）。 */
export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/**
 * 强杀一个 pid 及其子树；返回 taskkill 是否成功。
 * 进程已经退出时返回 false（调用方按「本来就没了」处理）。
 */
export function killPidTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    return result.status === 0;
  }
  try {
    process.kill(-pid, 'SIGKILL');
    return true;
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * 启动前的进程 pid 快照，作为「哪些进程本来就存在」的基线。
 * 用 tasklist（快，约几十毫秒）而不是 WMI —— 这里只需要 pid 集合。
 */
export function snapshotPids() {
  if (process.platform !== 'win32') {
    const result = spawnSync('ps', ['-A', '-o', 'pid='], { encoding: 'utf8', maxBuffer: MAX_BUFFER });
    if (result.status !== 0 || !result.stdout) return null;
    const pids = new Set();
    for (const line of result.stdout.split(/\r?\n/u)) {
      const pid = Number(line.trim());
      if (Number.isInteger(pid) && pid > 0) pids.add(pid);
    }
    return pids.size > 0 ? pids : null;
  }
  const result = spawnSync('tasklist', ['/FO', 'CSV', '/NH'], {
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
  });
  if (result.status !== 0 || !result.stdout) return null;
  const pids = new Set();
  for (const line of result.stdout.split(/\r?\n/u)) {
    // CSV 五列：进程名、pid、会话名、会话号、内存。进程名可能是中文（乱码也不影响），
    // 第一段必须用 [^"]* —— 贪婪的 .* 会一路吃到会话号那一列，取到错的 pid。
    const match = /^\s*"([^"]*)","(\d+)"/u.exec(line);
    if (match) pids.add(Number(match[2]));
  }
  return pids.size > 0 ? pids : null;
}

let shellCache;

function powershell() {
  if (shellCache !== undefined) return shellCache;
  for (const candidate of ['pwsh.exe', 'powershell.exe']) {
    const probe = spawnSync(candidate, ['-NoLogo', '-NoProfile', '-Command', 'exit 0'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    if (probe.status === 0) {
      shellCache = candidate;
      return shellCache;
    }
  }
  shellCache = null;
  return shellCache;
}

/**
 * 枚举进程：pid / 父 pid / 创建时间 / 命令行。
 * 一次性取全量，停止时只查一次，约 0.3–0.5 秒。
 */
function listWindowsProcesses() {
  const shell = powershell();
  if (!shell) return null;
  const script = [
    "$ErrorActionPreference='Stop';",
    '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);',
    // 时间必须用「距今多久」而不是绝对时刻：CIM 的 CreationDate 是本地时间，
    // 若再走 ToUniversalTime() 会被时区二次换算（本机实测偏 8 小时），
    // 于是刚启动的进程会被当成老进程过滤掉。两端都用本地时间相减最稳。
    '$now=Get-Date;',
    'Get-CimInstance Win32_Process | ForEach-Object {',
    "  $age=''; if ($_.CreationDate) { $age=[int64](($now-$_.CreationDate).TotalMilliseconds) };",
    "  '{0}|{1}|{2}|{3}' -f $_.ProcessId,$_.ParentProcessId,$age,$_.CommandLine",
    '}',
  ].join(' ');
  const result = spawnSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    timeout: 20000,
  });
  if (result.status !== 0 || !result.stdout) return null;
  const list = [];
  for (const line of result.stdout.split(/\r?\n/u)) {
    const i1 = line.indexOf('|');
    if (i1 <= 0) continue;
    const i2 = line.indexOf('|', i1 + 1);
    if (i2 < 0) continue;
    const i3 = line.indexOf('|', i2 + 1);
    if (i3 < 0) continue;
    const pid = Number(line.slice(0, i1));
    const ppid = Number(line.slice(i1 + 1, i2));
    const rawAge = line.slice(i2 + 1, i3);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const age = rawAge ? Number(rawAge) : Number.NaN;
    list.push({
      pid,
      parentProcessId: Number.isInteger(ppid) && ppid > 0 ? ppid : 0,
      createdAt: Number.isFinite(age) ? Date.now() - age : null,
      command: line.slice(i3 + 1),
    });
  }
  return list.length > 0 ? list : null;
}

/** 统一成小写、正斜杠，并把 Git Bash 的 /d/xxx 折成 d:/xxx，便于比对。 */
function normalizePath(value) {
  let text = String(value ?? '').replace(/["']/gu, '').trim();
  if (!text) return '';
  text = text.replace(/\\/gu, '/');
  const drive = /^\/([a-zA-Z])(?=\/)/u.exec(text);
  if (drive) text = `${drive[1].toLowerCase()}:${text.slice(2)}`;
  return text.toLowerCase();
}

/**
 * 从启动项里提取「路径特征」，用于把断链的进程认回来。
 * 只收绝对路径样式（`/d/...`、`D:\...`、`\\server\...`），
 * 再加路径末段（如 `platform-admin`），因为子进程命令行里往往只剩这一段。
 */
export function ownershipHints(task, cwd) {
  const hints = new Set();
  const push = value => {
    const normalized = normalizePath(value);
    if (normalized.length >= 6) hints.add(normalized);
    const last = normalized.split('/').filter(Boolean).pop();
    if (last && last.length >= 4) hints.add(last);
  };
  push(cwd);
  for (const token of String(task?.command ?? '').split(/\s+/u)) {
    const raw = token.replace(/^["']/u, '').replace(/["']$/u, '');
    if (!raw) continue;
    if (!/^(?:\/|[A-Za-z]:[\\/]|\\\\)/u.test(raw)) continue;
    push(raw);
  }
  return hints;
}

function matchHints(command, hints) {
  if (!hints || hints.size === 0) return null;
  const text = normalizePath(command);
  if (!text) return null;
  for (const hint of hints) {
    if (text.includes(hint)) return hint;
  }
  return null;
}

/** 截断命令行，只用于日志展示。 */
export function shortCommand(command) {
  const text = String(command ?? '').replace(/\s+/gu, ' ').trim();
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}

/**
 * 清掉本次启动遗留的断链进程。
 *
 * @param {object} options
 * @param {number|null} options.rootPid 本次启动记录的根 pid（可能已经退出）
 * @param {Set<number>|null} options.baseline 启动前的 pid 基线；为 null 表示拿不到，
 *   此时只清理「父链仍能走到根进程」的部分，不做断链推断。
 * @param {number|null} options.since 本次启动的时间戳
 * @param {Set<string>} options.hints 启动项的路径特征
 * @param {Iterable<number>} [options.excludePids] 不能碰的 pid（例如其它启动项的根进程）
 * @param {Array<{rootPid:number|null, baseline:Set<number>|null, since:number|null, hints:Set<string>|null}>} [options.ownedElsewhere]
 *   其它启动项的归属信息；命中的进程算它们的，不动。
 * @returns {{supported: boolean, killed: Array<{pid:number,reason:string,hint:string|null,command:string}>, remaining: number[]}}
 */
export function sweepOwned({ rootPid, baseline, since, hints, excludePids, ownedElsewhere } = {}) {
  const outcome = { supported: false, killed: [], remaining: [] };
  if (process.platform !== 'win32') return outcome;

  const procs = listWindowsProcesses();
  if (!procs) return outcome;
  outcome.supported = true;

  const present = new Map();
  for (const proc of procs) present.set(proc.pid, proc);

  const toBase = value => (value instanceof Set && value.size > 0 ? value : null);
  const root = Number.isInteger(rootPid) && rootPid > 0 ? rootPid : 0;
  const base = toBase(baseline);

  const exclude = new Set();
  for (const pid of excludePids ?? []) {
    if (Number.isInteger(pid) && pid > 0) exclude.add(pid);
  }
  exclude.add(process.pid);

  function makeSpec(targetRoot, startBaseline, startAt, featureHints) {
    return {
      root: Number.isInteger(targetRoot) && targetRoot > 0 ? targetRoot : 0,
      base: toBase(startBaseline),
      floor: Number.isFinite(startAt) ? startAt - CLOCK_SLACK : null,
      hints: featureHints,
    };
  }

  /** 沿 PPID 上溯，判断这个进程能否归属到某个启动项。 */
  function trace(pid, targetRoot, knownBase) {
    const path = [];
    const seen = new Set([pid]);
    let cursor = present.get(pid)?.parentProcessId ?? 0;
    for (let depth = 0; depth < WALK_LIMIT; depth += 1) {
      if (!cursor) return { hit: null, path };
      if (targetRoot && cursor === targetRoot) {
        path.push(cursor);
        return { hit: 'root', path };
      }
      if (present.has(cursor)) {
        if (seen.has(cursor)) return { hit: null, path };
        seen.add(cursor);
        path.push(cursor);
        cursor = present.get(cursor).parentProcessId;
        continue;
      }
      path.push(cursor);
      // 父进程已经不在了：只有「它本身也不在启动前基线里」才说明它是本次启动
      // 期间才诞生又消失的中间层（正是 exec 换 pid 留下的断链点）。
      return { hit: knownBase && !knownBase.has(cursor) ? 'broken' : null, deadPid: cursor, path };
    }
    return { hit: null, path };
  }

  /** 判定一个进程是否属于某个启动项；返回归属理由与父链。 */
  function classify(proc, spec) {
    if (spec.root && proc.pid === spec.root) return null;
    if (spec.floor !== null && proc.createdAt !== null && proc.createdAt < spec.floor) return null;
    const result = trace(proc.pid, spec.root, spec.base);
    if (result.hit === 'root') return { reason: '子树', hint: null, path: result.path };
    if (result.hit === 'broken') {
      // 断链还要命令行佐证：否则可能是别的东西，宁可不杀。
      const hint = matchHints(proc.command, spec.hints);
      if (!hint) return null;
      return { reason: '断链', hint, path: result.path };
    }
    return null;
  }

  const self = makeSpec(root, baseline, since, hints);
  const others = (ownedElsewhere ?? []).map(item => makeSpec(item.rootPid, item.baseline, item.since, item.hints));

  /** @type {Map<number, {reason:string, hint:string|null, command:string}>} */
  const targets = new Map();

  for (const proc of procs) {
    const skipped = proc.pid === root
      ? 'root'
      : exclude.has(proc.pid)
        ? 'exclude'
        : base?.has(proc.pid)
          ? 'baseline'
          : self.floor !== null && proc.createdAt !== null && proc.createdAt < self.floor
            ? 'floor'
            : null;
    if (skipped) continue;
    const verdict = classify(proc, self);
    if (!verdict) continue;
    // 别的启动项也在跑（可能命令一模一样）：先让位，谁的孩子归谁。
    if (others.some(other => classify(proc, other))) continue;
    targets.set(proc.pid, { reason: verdict.reason, hint: verdict.hint, command: proc.command });
    // 同一棵树上的中间层（bash → npm → cmd → vite）一并收下，
    // 只杀末端会让 npm 那串留在后台。
    for (const ancestor of verdict.path) {
      if (ancestor === root || exclude.has(ancestor)) break;
      const parent = present.get(ancestor);
      if (!parent) continue;
      if (base?.has(ancestor)) break;
      if (self.floor !== null && parent.createdAt !== null && parent.createdAt < self.floor) break;
      if (others.some(other => other.root === ancestor || classify(parent, other))) break;
      if (!targets.has(ancestor)) targets.set(ancestor, { reason: '祖先', hint: null, command: parent.command });
    }
  }

  if (targets.size === 0) return outcome;
  if (targets.size > MAX_SWEEP) {
    // 规模异常说明判据跑偏了，宁可什么都不动，把候选交给上层记日志。
    outcome.remaining = [...targets.keys()];
    return outcome;
  }

  for (const [pid, info] of targets) {
    const killed = killPidTree(pid) || !isAlive(pid);
    if (!killed) {
      outcome.remaining.push(pid);
      continue;
    }
    outcome.killed.push({ pid, reason: info.reason, hint: info.hint, command: info.command });
  }
  return outcome;
}
