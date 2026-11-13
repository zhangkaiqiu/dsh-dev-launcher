/**
 * 每个「快捷启动项」一个长期子进程，带环形日志缓冲、落盘日志与进程树终止。
 *
 * 设计要点：
 * - 内存只保留「当前这一次启动」的最近 MAX_LINES 行，读端用单调序号 n 做增量拉取，
 *   所以 UI 和 Agent 各自读，互不消费。
 * - 每次启动生成新的 runId：行号从头开始，读端据此判断「换了一代」并清空旧内容。
 * - 同一个任务的完整历史追加写在 logFile 里（由调用方给路径），内存丢了文件还在。
 * - 停止必须杀整棵进程树：`npm run dev` 是 cmd → node 两层，
 *   Windows 上 child.kill() 只杀第一层，node 会变孤儿。
 * - 树是不牢靠的：Git Bash 的 `exec` 会把 pid 换掉、把父子链断在中间，
 *   所以启动时记一份 pid 基线与路径特征，停止时交给 procs.sweepOwned() 兜底。
 */

import { spawn } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import path from 'node:path';

import { isAlive, killPidTree, ownershipHints, shortCommand, snapshotPids, sweepOwned } from './procs.js';

export { isAlive, killPidTree };

const MAX_LINES = 3000;
const MAX_PARTIAL = 64 * 1024;
const MAX_ERROR_LENGTH = 500;

let runSequence = 0;

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/gu;
const NOISE = [/\b0 (?:errors?|warnings?)\b/iu, /\bno errors?\b/iu, /error(?:s)?:\s*0\b/iu];

function stripAnsi(input) {
  return input.replace(ANSI, '');
}

function isErrorLine(line) {
  if (NOISE.some(pattern => pattern.test(line))) return false;
  return (
    /\b(?:error|exception|fatal|failed|failure|refused|denied|unhandled)\b/iu.test(line) ||
    /EADDRINUSE|ELIFECYCLE|ENOENT|ECONNREFUSED|EACCES/u.test(line) ||
    /cannot find module|command not found|is not recognized|Traceback \(most recent call last\)|panic:/iu.test(line)
  );
}

function createRuntime({ key, task, cwd }) {
  return {
    key,
    id: task.id,
    name: task.name,
    command: task.command,
    cwd,
    env: task.env ?? {},
    /** 每一次启动一个新值；读端据此判断日志换了「代」。 */
    runId: null,
    /** 落盘文件（追加写）；为空表示不落盘。 */
    logFile: null,
    stream: null,
    child: null,
    pid: null,
    /** spawn 时拿到的根 pid，exit 之后仍然保留，停止清扫要靠它认树。 */
    rootPid: null,
    /** 启动前的全机 pid 基线；null 表示当时没取到。 */
    baseline: null,
    /** 从命令里提取的路径特征，用于把断链的子孙认回来。 */
    hints: null,
    status: 'idle',
    startedAt: null,
    endedAt: null,
    exitCode: null,
    signal: null,
    lines: [],
    next: 1,
    errorCount: 0,
    lastError: null,
    partial: '',
    stopping: false,
    exitLogged: false,
    pendingEnd: null,
  };
}

function push(runtime, stream, raw) {
  const text = stripAnsi(raw).replace(/\r$/u, '');
  const line = { n: runtime.next, s: stream, t: Date.now(), text };
  runtime.next += 1;
  runtime.lines.push(line);
  if (runtime.lines.length > MAX_LINES) runtime.lines.splice(0, runtime.lines.length - MAX_LINES);
  if (runtime.stream) {
    try {
      runtime.stream.write(`${text}\n`);
    } catch {
      runtime.stream = null;
    }
  }
  if (isErrorLine(text)) {
    runtime.errorCount += 1;
    runtime.lastError = text.slice(0, MAX_ERROR_LENGTH);
  }
}

function consume(runtime, stream, chunk) {
  runtime.partial += chunk;
  let index = runtime.partial.indexOf('\n');
  while (index >= 0) {
    push(runtime, stream, runtime.partial.slice(0, index));
    runtime.partial = runtime.partial.slice(index + 1);
    index = runtime.partial.indexOf('\n');
  }
  if (runtime.partial.length > MAX_PARTIAL) {
    push(runtime, stream, runtime.partial);
    runtime.partial = '';
  }
}

function closeStream(runtime) {
  if (!runtime.stream) return;
  try {
    runtime.stream.end();
  } catch {
    // 流已关闭。
  }
  runtime.stream = null;
}

/** 记录退出事实并切换状态；返回 false 表示已经记过了。 */
function markEnded(runtime, code, signal) {
  if (runtime.endedAt) return false;
  runtime.endedAt = Date.now();
  runtime.exitCode = typeof code === 'number' ? code : null;
  runtime.signal = signal ?? null;
  if (runtime.stopping) {
    runtime.status = 'stopped';
  } else {
    runtime.status = code === 0 ? 'exited' : 'failed';
  }
  runtime.stopping = false;
  return true;
}

/** 把「进程退出」写进日志；exit 与 close 两条路径都可能先到，所以只记一次。 */
function logExit(runtime, code, signal) {
  if (runtime.exitLogged) return;
  runtime.exitLogged = true;
  if (runtime.partial) {
    push(runtime, 'out', runtime.partial);
    runtime.partial = '';
  }
  push(runtime, runtime.status === 'failed' ? 'err' : 'out', `进程退出 (code=${code ?? 'null'}${signal ? `, signal=${signal}` : ''})`);
}

/**
 * 收尾：`exit` 先到就先把状态改对，再把剩余输出和文件流收干净。
 * 两次调用是幂等的（`exit` 与 `close` 都会走这里）。
 */
function finish(runtime, code, signal) {
  if (runtime.pendingEnd) {
    clearTimeout(runtime.pendingEnd);
    runtime.pendingEnd = null;
  }
  runtime.child = null;
  runtime.pid = null;
  markEnded(runtime, code, signal);
  logExit(runtime, code, signal);
  closeStream(runtime);
}

/**
 * 打掉根进程的进程树。返回是否作用到了还在运行的进程。
 *
 * taskkill 对已退出的 pid 会返回非 0，所以不能当成「已成功」；
 * 那正是断链场景：根还在、树里有别人，或者根早没了、树还活着。
 */
function killTree(runtime) {
  const rootPid = runtime.rootPid ?? runtime.pid;
  if (!rootPid) return false;
  if (killPidTree(rootPid)) return true;
  try {
    runtime.child?.kill('SIGKILL');
    return true;
  } catch {
    return false;
  }
}

/** 等子进程真的退出（最多 timeout 毫秒），让状态在接口返回前就落定。 */
function waitExit(runtime, timeout) {
  if (!runtime.child) return Promise.resolve();
  return new Promise(resolve => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (!runtime.child || Date.now() - started >= timeout) {
        clearInterval(timer);
        resolve();
      }
    }, 40);
    timer.unref?.();
  });
}

let bashPathCache;

/**
 * Git Bash 在 Windows 上常常不在 PATH 里（只把 git.exe 装进了 PATH），
 * 所以要自己找安装位置。
 *
 * 关键：必须用 `usr\bin\bash.exe`，不能用 `bin\bash.exe`。
 * 后者是启动器，它 `_wexecv` 到真正的 bash 后自己退出 —— Windows 的 exec 是
 * 「新建进程 + 退出旧进程」，pid 会变，于是停止时 taskkill 打在一个已死的 pid 上，
 * 整个进程树原地不动。
 */
function bashExecutable() {
  if (process.platform !== 'win32') return 'bash';
  if (bashPathCache !== undefined) return bashPathCache;
  const roots = [
    process.env.ProgramFiles,
    process.env.ProgramW6432,
    process.env['ProgramFiles(x86)'],
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs') : undefined,
  ].filter(root => typeof root === 'string' && root);
  const candidates = [];
  for (const root of roots) {
    candidates.push(path.join(root, 'Git', 'usr', 'bin', 'bash.exe'));
    candidates.push(path.join(root, 'Git', 'bin', 'bash.exe'));
  }
  bashPathCache = candidates.find(candidate => existsSync(candidate)) ?? 'bash';
  return bashPathCache;
}

/**
 * 解析启动项用哪个 shell。
 *
 * 默认走平台 shell（Windows 上是 cmd.exe）。要 PowerShell / Git Bash 时不能依赖
 * Node 的 `shell` 选项：它在 Windows 上一律拼 cmd 的 `/d /s /c` 参数，
 * 所以这里自己拼 argv，命令原样作为最后一个参数传进去，不需要额外转义。
 */
function spawnSpec(task) {
  const mode = task.shell ?? 'default';
  if (mode === 'pwsh' || mode === 'powershell') {
    const executable = mode === 'pwsh'
      ? (process.platform === 'win32' ? 'pwsh.exe' : 'pwsh')
      : (process.platform === 'win32' ? 'powershell.exe' : 'powershell');
    return { mode, file: executable, args: ['-NoLogo', '-NoProfile', '-Command', task.command], options: {} };
  }
  if (mode === 'bash') {
    return { mode, file: bashExecutable(), args: ['-lc', task.command], options: {} };
  }
  return { mode, file: task.command, args: [], options: { shell: true } };
}

export function createRunner({ onChange } = {}) {
  /** @type {Map<string, Map<string, ReturnType<typeof createRuntime>>>} */
  const workspaces = new Map();
  let disposed = false;

  function bucket(key) {
    let map = workspaces.get(key);
    if (!map) {
      map = new Map();
      workspaces.set(key, map);
    }
    return map;
  }

  function notify() {
    try {
      onChange?.();
    } catch {
      // 通知失败不能影响进程管理。
    }
  }

  function summary(runtime) {
    return {
      id: runtime.id,
      name: runtime.name,
      command: runtime.command,
      cwd: runtime.cwd,
      runId: runtime.runId,
      logFile: runtime.logFile,
      status: runtime.status,
      pid: runtime.pid,
      startedAt: runtime.startedAt,
      endedAt: runtime.endedAt,
      exitCode: runtime.exitCode,
      signal: runtime.signal,
      lineCount: runtime.next - 1,
      errorCount: runtime.errorCount,
      lastError: runtime.lastError,
    };
  }

  /**
   * 其它启动项的归属信息（跨工作区）：清扫时既不能碰它们的根进程，
   * 也不能把它们的子孙当成自己的残留 —— 两个启动项的命令可能一模一样。
   */
  function foreignTasks(key, taskId) {
    const specs = [];
    for (const [mapKey, map] of workspaces) {
      for (const [id, item] of map) {
        if (mapKey === key && id === taskId) continue;
        // 已经停掉的启动项不再参与让位判定：它的归属信息会一直把后来
        // 启动的同命令进程认成自己的，导致谁也停不掉。
        if (!item.child) continue;
        const rootPid = item.rootPid ?? item.pid;
        if (!Number.isInteger(rootPid) || rootPid <= 0) continue;
        specs.push({ rootPid, baseline: item.baseline, since: item.startedAt, hints: item.hints });
      }
    }
    return specs;
  }

  return {
    /** 该工作区里所有「本进程启动过」的运行态摘要。 */
    list(key) {
      const map = workspaces.get(key);
      return map ? [...map.values()].map(summary) : [];
    },

    /** 外部只拿摘要：原始句柄（child/stream）不能跨进程边界序列化。 */
    get(key, taskId) {
      const runtime = workspaces.get(key)?.get(taskId);
      return runtime ? summary(runtime) : undefined;
    },

    /** 已产出的日志行数（单调递增的序号上界）。 */
    count(key, taskId) {
      const runtime = workspaces.get(key)?.get(taskId);
      return runtime ? runtime.next - 1 : 0;
    },

    start({ key, task, cwd, logPath }) {
      if (disposed) throw new Error('插件已卸载');
      const map = bucket(key);
      let runtime = map.get(task.id);
      if (runtime?.child) {
        throw new Error(runtime.stopping ? `「${runtime.name}」正在停止，请稍后再启动` : `「${runtime.name}」已在运行`);
      }
      runtime = createRuntime({ key, task, cwd });
      runSequence += 1;
      runtime.runId = `${Date.now().toString(36)}-${runSequence.toString(36)}`;
      map.set(task.id, runtime);

      if (typeof logPath === 'string' && logPath) {
        runtime.logFile = logPath;
        try {
          // 每次启动覆盖写：文件只保留「最后一次启动」的输出，与界面看到的一致。
          runtime.stream = createWriteStream(logPath, { flags: 'w' });
          runtime.stream.on('error', () => {
            runtime.stream = null;
          });
          runtime.stream.write(`===== ${new Date().toLocaleString()} 启动: ${task.command} =====\n`);
        } catch {
          runtime.stream = null;
        }
      }

      const spec = spawnSpec(task);

      // 基线必须在 spawn 之前取：子进程一旦起来就会混进快照，那之后就分不清
      // 谁是「本来就有的」了。tasklist 一次约几十毫秒，只在启动时付一次。
      runtime.hints = ownershipHints(task, cwd);
      runtime.baseline = snapshotPids();
      runtime.status = 'running';
      runtime.startedAt = Date.now();
      push(runtime, 'out', `$ ${spec.mode === 'default' || spec.mode === 'cmd' ? '' : `[${spec.mode}] `}${task.command}`);

      let child;
      try {
        child = spawn(spec.file, spec.args, {
          cwd,
          env: { ...process.env, ...runtime.env },
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
          ...spec.options,
        });
      } catch (error) {
        runtime.status = 'failed';
        runtime.endedAt = Date.now();
        push(runtime, 'err', `启动失败: ${error instanceof Error ? error.message : String(error)}`);
        notify();
        return summary(runtime);
      }

      runtime.child = child;
      runtime.pid = child.pid ?? null;
      runtime.rootPid = runtime.pid;
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', chunk => consume(runtime, 'out', String(chunk)));
      child.stderr?.on('data', chunk => consume(runtime, 'err', String(chunk)));
      child.on('error', error => {
        runtime.status = 'failed';
        push(runtime, 'err', `启动失败: ${error instanceof Error ? error.message : String(error)}`);
        finish(runtime, null, null);
        notify();
      });
      child.on('exit', (code, signal) => {
        // exit 只说明进程自己走了；stdio 管道可能还被孙进程握着，close 不一定会来。
        // 所以先在这里把状态改对，再给 close 一点时间把剩余输出收干净。
        runtime.child = null;
        runtime.pid = null;
        if (!markEnded(runtime, code, signal)) return;
        logExit(runtime, code, signal);
        runtime.pendingEnd = setTimeout(() => {
          finish(runtime, code, signal);
          notify();
        }, 800);
        runtime.pendingEnd.unref?.();
        notify();
      });
      child.on('close', (code, signal) => {
        finish(runtime, code, signal);
        notify();
      });
      notify();
      return summary(runtime);
    },

    /**
     * 停止一个任务：先打根进程的树，再按归属证据清掉断链的那部分。
     * 返回 null 表示这个任务从没启动过。
     */
    async stop(key, taskId) {
      const runtime = workspaces.get(key)?.get(taskId);
      if (!runtime) return null;
      const wasRunning = Boolean(runtime.child);
      const rootPid = runtime.rootPid ?? runtime.pid;
      if (!wasRunning && !rootPid) return null;

      runtime.stopping = true;
      push(runtime, 'out', wasRunning ? '正在停止…' : '根进程已退出，正在清理残留…');
      if (wasRunning) {
        const hit = killTree(runtime);
        if (!hit) {
          try {
            runtime.child?.kill('SIGKILL');
          } catch {
            // 已经退出。
          }
        }
        // 等 exit 事件把状态改成 stopped，否则界面会闪一下「运行中」。
        await waitExit(runtime, 800);
      }
      notify();

      const foreign = foreignTasks(key, taskId);
      const swept = sweepOwned({
        rootPid,
        baseline: runtime.baseline,
        since: runtime.startedAt,
        hints: runtime.hints,
        excludePids: foreign.map(item => item.rootPid),
        ownedElsewhere: foreign,
      });

      for (const item of swept.killed) {
        const hint = item.hint ? `，匹配 "${item.hint}"` : '';
        push(runtime, 'out', `已结束残留进程 ${item.pid}（${item.reason}${hint}）: ${shortCommand(item.command)}`);
      }
      if (swept.remaining.length > 0) {
        push(runtime, 'err', `仍有进程没退出，可能需要手动处理: ${swept.remaining.join(', ')}`);
      }
      notify();

      return {
        wasRunning,
        status: runtime.status,
        killed: swept.killed,
        remaining: swept.remaining,
        supported: swept.supported,
      };
    },

    /**
     * 增量读日志。`after` 是上一次读到的行号；传负数或缺省表示「取最后 limit 行」，
     * 这样界面第一次打开时不必重放整个日志。
     */
    logs({ key, taskId, after = -1, limit = 300 }) {
      const runtime = workspaces.get(key)?.get(taskId);
      if (!runtime) return { runId: null, logFile: null, lines: [], next: 0, total: 0, status: 'missing' };
      const count = Math.min(Math.max(1, Math.floor(limit) || 300), 1000);
      const from = Number(after);
      const lines = !Number.isFinite(from) || from < 0
        ? runtime.lines.slice(Math.max(0, runtime.lines.length - count))
        : runtime.lines.filter(line => line.n > from).slice(0, count);
      return {
        runId: runtime.runId,
        logFile: runtime.logFile,
        lines,
        next: lines.length > 0 ? lines[lines.length - 1].n : Math.max(0, runtime.next - 1),
        total: runtime.next - 1,
        status: runtime.status,
      };
    },

    /** 该工作区里「最需要被看到」的运行态：先失败，再运行中，再其余。 */
    focus(key) {
      const map = workspaces.get(key);
      if (!map) return undefined;
      const all = [...map.values()];
      return (
        all.find(item => item.status === 'failed') ??
        all.find(item => item.child) ??
        all[all.length - 1]
      );
    },

    dispose() {
      disposed = true;
      for (const map of workspaces.values()) {
        for (const runtime of map.values()) {
          if (runtime.pendingEnd) {
            clearTimeout(runtime.pendingEnd);
            runtime.pendingEnd = null;
          }
          if (runtime.stream) {
            try {
              runtime.stream.end();
            } catch {
              // 流已关闭。
            }
            runtime.stream = null;
          }
          if (!runtime.child) continue;
          runtime.stopping = true;
          killTree(runtime);
        }
      }
    },
  };
}
