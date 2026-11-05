/**
 * DSH 快捷启动器 —— Host 半。
 *
 * 职责：
 * 1. 按工作区保存「快捷启动项」配置（scripts），存在 $DSH_HOME/dev-launcher/tasks.json。
 * 2. 每个启动项对应一个长期子进程，保留最近日志，可随时启停。
 * 3. 通过 HTTP 路由服务界面，通过 Agent 工具让会话直接读状态与日志。
 *
 * UI 与 Agent 走同一套方法（listProjects / startTask / stopTask / readLogs），
 * 不存在两套逻辑。
 */

import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createRunner, isAlive, killPidTree } from './lib/runner.js';
import { createStore, workspaceKey } from './lib/store.js';

export const name = 'dsh-dev-launcher';
export const inject = ['webServer', 'tools'];

const ROUTE_PREFIX = '/dev-launcher';
const MAX_TOOL_CHARS = 12000;
/** 日志落盘在「工作区内的 .tmp」：跟着项目走，清 .tmp 就一并清掉。 */
const LOG_DIR = ['.tmp', 'dev-logs'];

function dataDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'dev-launcher');
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  let bytes = 0;
  for await (const raw of req) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    bytes += chunk.byteLength;
    if (bytes > 512 * 1024) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (bytes === 0) return {};
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求体必须是 JSON 对象');
  return value;
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function explanation(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 把一个绝对目录归到所属工作区：命中已注册工作区就用它，
 * 否则向上找最近的已注册祖先，都没有就把目录本身当作工作区。
 */
export function resolveWorkspace(ctx, directory) {
  const registry = ctx.get?.('workspaceRegistry');
  const list = Array.isArray(registry?.list?.()) ? registry.list() : [];
  const known = new Map();
  for (const workspace of list) {
    if (typeof workspace?.path === 'string' && workspace.path) known.set(workspaceKey(workspace.path), workspace);
  }
  const start = path.resolve(directory);
  let cursor = start;
  for (;;) {
    const hit = known.get(workspaceKey(cursor));
    if (hit) return { key: workspaceKey(hit.path), root: hit.path, title: hit.title || path.basename(hit.path) };
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return { key: workspaceKey(start), root: start, title: path.basename(start) || start };
}

/** 会话的生效目录：优先 Host 记录的 workingDirectory，失败则用调用方给的兜底值。 */
export async function directoryOf(ctx, sessionId, fallback) {
  if (typeof sessionId === 'string' && sessionId) {
    try {
      const agent = ctx.get?.('agents')?.get?.(sessionId);
      if (agent) {
        const directory = await ctx.get?.('workingDirectory')?.ensure?.(agent);
        if (typeof directory === 'string' && directory) return directory;
      }
    } catch {
      // 目录不可恢复时退回兜底值。
    }
  }
  if (typeof fallback === 'string' && fallback.trim()) return path.resolve(fallback.trim());
  const defaultDirectory = ctx.get?.('workingDirectory')?.defaultDirectory;
  return typeof defaultDirectory === 'string' && defaultDirectory ? defaultDirectory : process.cwd();
}

function taskLabel(task) {
  return task.name || task.command;
}

function logDirectory(workspace) {
  return path.join(workspace.root, ...LOG_DIR);
}

function relativeLogDirectory() {
  return LOG_DIR.join('/');
}

function safeFileStem(task) {
  const raw = String(task.name || task.id);
  const cleaned = raw.replace(/[\\/:*?"<>|\s]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 40);
  return cleaned || task.id;
}

function logFilePath(workspace, task) {
  return path.join(logDirectory(workspace), `${safeFileStem(task)}-${task.id}.log`);
}

/** 日志每次启动覆盖写，所以只需要确保目录存在。 */
async function prepareLogFile(workspace, task) {
  const file = logFilePath(workspace, task);
  try {
    await mkdir(logDirectory(workspace), { recursive: true });
    return file;
  } catch {
    return undefined;
  }
}

async function readLogFileTail(file, maxLines) {
  try {
    const raw = await readFile(file, 'utf8');
    const lines = raw.split(/\r?\n/u);
    if (lines.length > maxLines) lines.splice(0, lines.length - maxLines);
    const text = lines.join('\n');
    if (text.length > MAX_TOOL_CHARS) return `…(仅显示末尾 ${MAX_TOOL_CHARS} 字符)\n${text.slice(-MAX_TOOL_CHARS)}`;
    return text;
  } catch (error) {
    return `(读取日志文件失败: ${explanation(error)})`;
  }
}

/**
 * 防 CSRF：浏览器跨站发起的请求一定带 Origin / Sec-Fetch-Site，
 * 拒绝它们；本地工具（curl、脚本）两者都没有，放行。
 * 这道检查保证一条恶意网页不能通过 POST /dev-launcher/save + /start 在用户机器上执行命令。
 */
function isCrossSite(req) {
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && site && site !== 'same-origin' && site !== 'none') return true;
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin) {
    try {
      return new URL(origin).host !== req.headers.host;
    } catch {
      return true;
    }
  }
  return false;
}

/** 在系统文件管理器里打开一个目录；失败不抛出（接口照常返回路径）。 */
function revealDirectory(target) {
  const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  try {
    spawn(command, [target], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // 打不开也把路径回给调用方。
  }
}

/** 拼一段给模型读的日志文本，带行号与流向，并限制总长度。 */
function formatLines(lines) {
  if (lines.length === 0) return '(没有新的日志行)';
  const body = lines.map(line => `${line.n}\t${line.s === 'err' ? 'stderr' : 'stdout'}\t${line.text}`).join('\n');
  if (body.length > MAX_TOOL_CHARS) {
    return `…(仅显示末尾 ${MAX_TOOL_CHARS} 字符)\n${body.slice(-MAX_TOOL_CHARS)}`;
  }
  return body;
}

export function apply(ctx) {
  const dir = dataDir();
  const store = createStore({ dir });
  const runner = createRunner();
  const pidFile = path.join(dir, 'running.json');

  /** 本次进程启动的子进程 pid，用于退出时清理和下次启动时兜底。 */
  const livePids = new Map();
  const ORPHAN_MAX_AGE = 7 * 24 * 3600 * 1000;

  function syncPidFile() {
    const snapshot = {};
    for (const [key, entry] of livePids) snapshot[key] = entry;
    void mkdir(dir, { recursive: true })
      .then(() => writeFile(pidFile, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8'))
      .catch(() => undefined);
  }

  /** 上一个 Host 进程崩溃留下的子进程：能确认活着就清掉（只清理一周内的记录）。 */
  async function sweepOrphans() {
    let previous;
    try {
      previous = JSON.parse(await readFile(pidFile, 'utf8'));
    } catch {
      return;
    }
    if (!previous || typeof previous !== 'object') return;
    const now = Date.now();
    let cleaned = 0;
    for (const entry of Object.values(previous)) {
      const pid = typeof entry === 'number' ? entry : Number(entry?.pid);
      const at = typeof entry === 'object' && entry ? Number(entry.at) : now;
      if (!Number.isInteger(pid) || pid <= 0) continue;
      if (Number.isFinite(at) && now - at > ORPHAN_MAX_AGE) continue;
      if (!isAlive(pid)) continue;
      if (killPidTree(pid)) cleaned += 1;
    }
    if (cleaned > 0) console.log(`[dsh-dev-launcher] 清理了 ${cleaned} 个上次运行遗留的进程`);
    await writeFile(pidFile, '{}\n', 'utf8').catch(() => undefined);
  }

  // ---- 核心操作：UI 与工具共用 ----

  async function listProjects(directory) {
    const workspace = resolveWorkspace(ctx, directory);
    const stored = await store.read(workspace.key);
    const live = new Map(runner.list(workspace.key).map(item => [item.id, item]));
    const tasks = stored.tasks.map(task => {
      const runtime = live.get(task.id) ?? null;
      const file = runtime?.logFile;
      return {
        ...task,
        runtime,
        logFile: file ? path.relative(workspace.root, file).replace(/\\/gu, '/') : null,
      };
    });
    return { workspace: { ...workspace, logDir: relativeLogDirectory(), tasks }, tasks };
  }

  async function findTask(workspace, taskId) {
    const stored = await store.read(workspace.key);
    return stored.tasks.find(task => task.id === taskId);
  }

  function taskCwd(workspace, task) {
    return path.resolve(workspace.root, task.cwd || '.');
  }

  async function startTask({ directory, taskId }) {
    const workspace = resolveWorkspace(ctx, directory);
    const task = await findTask(workspace, taskId);
    if (!task) throw new Error(`工作区里没有启动项 ${taskId}`);
    const cwd = taskCwd(workspace, task);
    const logPath = await prepareLogFile(workspace, task);
    const runtime = runner.start({ key: workspace.key, task, cwd, logPath });
    livePids.set(`${workspace.key}::${taskId}`, { pid: runtime.pid, at: Date.now() });
    syncPidFile();
    return {
      workspace: workspace.root,
      task: runtime,
      logFile: runtime.logFile ? path.relative(workspace.root, runtime.logFile).replace(/\\/gu, '/') : null,
    };
  }

  async function stopTask({ directory, taskId }) {
    const workspace = resolveWorkspace(ctx, directory);
    const stopped = runner.stop(workspace.key, taskId);
    if (!stopped) throw new Error('该启动项当前没有在运行');
    livePids.delete(`${workspace.key}::${taskId}`);
    syncPidFile();
    return { workspace: workspace.root, task: runner.get(workspace.key, taskId) };
  }

  async function saveTask({ directory, task }) {
    const workspace = resolveWorkspace(ctx, directory);
    const saved = await store.saveTask({ key: workspace.key, root: workspace.root, task });
    return { workspace: workspace.root, task: saved };
  }

  async function deleteTask({ directory, taskId }) {
    const workspace = resolveWorkspace(ctx, directory);
    const runtime = runner.get(workspace.key, taskId);
    if (runtime?.pid) runner.stop(workspace.key, taskId);
    const removed = await store.deleteTask({ key: workspace.key, taskId });
    if (!removed) throw new Error('启动项不存在');
    return { workspace: workspace.root };
  }

  async function readLogs({ directory, taskId, after, limit }) {
    const workspace = resolveWorkspace(ctx, directory);
    const target = taskId || runner.focus(workspace.key)?.id;
    if (!target) return { workspace: workspace.root, taskId: null, lines: [], next: after ?? 0, status: 'missing' };
    return { workspace: workspace.root, taskId: target, ...runner.logs({ key: workspace.key, taskId: target, after, limit }) };
  }

  // ---- 装配 ----

  ctx.effect(() => {
    void mkdir(dir, { recursive: true }).catch(() => undefined);
    void sweepOrphans();
    return () => {
      runner.dispose();
      void writeFile(pidFile, '{}\n', 'utf8').catch(() => undefined);
    };
  }, 'dsh-dev-launcher: 进程池');

  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://dsh.local');
        const route = url.pathname.replace(/^\/dev-launcher\/?/u, '').replace(/\/$/u, '');
        try {
          if (isCrossSite(req)) {
            sendJson(res, 403, { ok: false, error: '拒绝跨站请求' });
            return;
          }
          if (route === 'state' && req.method === 'GET') {
            const directory = await directoryOf(ctx, url.searchParams.get('sessionId'), url.searchParams.get('cwd'));
            const { workspace, tasks } = await listProjects(directory);
            sendJson(res, 200, { ok: true, value: { workspace, tasks } });
            return;
          }

          if (route === 'logs' && req.method === 'GET') {
            const directory = await directoryOf(ctx, url.searchParams.get('sessionId'), url.searchParams.get('cwd'));
            const rawAfter = url.searchParams.get('after');
            const result = await readLogs({
              directory,
              taskId: url.searchParams.get('taskId') ?? undefined,
              after: rawAfter === null || rawAfter === '' ? -1 : Number(rawAfter),
              limit: Number(url.searchParams.get('limit') ?? 400),
            });
            sendJson(res, 200, { ok: true, value: result });
            return;
          }

          if (route === 'start' && req.method === 'POST') {
            const body = await readJson(req);
            const directory = await directoryOf(ctx, text(body.sessionId), text(body.cwd));
            sendJson(res, 200, { ok: true, value: await startTask({ directory, taskId: text(body.taskId) }) });
            return;
          }

          if (route === 'stop' && req.method === 'POST') {
            const body = await readJson(req);
            const directory = await directoryOf(ctx, text(body.sessionId), text(body.cwd));
            sendJson(res, 200, { ok: true, value: await stopTask({ directory, taskId: text(body.taskId) }) });
            return;
          }

          if (route === 'save' && req.method === 'POST') {
            const body = await readJson(req);
            const directory = await directoryOf(ctx, text(body.sessionId), text(body.cwd));
            sendJson(res, 200, { ok: true, value: await saveTask({ directory, task: body.task }) });
            return;
          }

          if (route === 'delete' && req.method === 'POST') {
            const body = await readJson(req);
            const directory = await directoryOf(ctx, text(body.sessionId), text(body.cwd));
            sendJson(res, 200, { ok: true, value: await deleteTask({ directory, taskId: text(body.taskId) }) });
            return;
          }

          if (route === 'reveal' && req.method === 'POST') {
            const body = await readJson(req);
            const directory = await directoryOf(ctx, text(body.sessionId), text(body.cwd));
            const workspace = resolveWorkspace(ctx, directory);
            const target = logDirectory(workspace);
            await mkdir(target, { recursive: true }).catch(() => undefined);
            revealDirectory(target);
            sendJson(res, 200, { ok: true, value: { directory: target, relative: relativeLogDirectory() } });
            return;
          }

          sendJson(res, 404, { ok: false, error: `未知的接口 ${route || '/'}` });
        } catch (error) {
          sendJson(res, 200, { ok: false, error: explanation(error) });
        }
      },
    });
    return () => dispose();
  }, 'dsh-dev-launcher: HTTP 路由');

  ctx.effect(() => {
    const disposers = [];

    const directoryForTool = async exec => directoryOf(ctx, exec?.agent?.id, undefined);

    disposers.push(
      ctx.tools.register({
        name: 'dev_task_list',
        description:
          '列出当前工作区里用户配置好的「快捷启动项」（例如前端 dev server、后端服务）以及它们此刻的运行状态：是否在跑、退出码、最近一条错误。' +
          '用户提到服务没起来、端口、启动失败、后端接口不通、前端白屏之类的问题时，先调用它确认哪些服务在运行、哪些已经退出。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: {
          schema: { type: 'object', properties: { text: { type: 'string' } }, additionalProperties: false },
          render(_args, value) {
            return [{ type: 'text', text: String(value?.text ?? '') }];
          },
        },
        async execute(_args, exec) {
          const directory = await directoryForTool(exec);
          const { workspace, tasks } = await listProjects(directory);
          if (tasks.length === 0) {
            return {
              text: `工作区 ${workspace.root} 还没有配置任何快捷启动项。让用户在对话框右上角的「快捷启动」里添加。`,
            };
          }
          const rows = tasks.map(task => {
            const runtime = task.runtime;
            const status = runtime?.status ?? 'idle';
            const suffix =
              status === 'running'
                ? `pid=${runtime.pid}`
                : status === 'failed'
                  ? `exitCode=${runtime.exitCode}`
                  : status === 'exited' || status === 'stopped'
                    ? `exitCode=${runtime.exitCode ?? 0}`
                    : '—';
            const error = runtime?.errorCount ? `，错误行 ${runtime.errorCount} 条` : '';
            const last = runtime?.lastError ? `，最近错误: ${runtime.lastError}` : '';
            return `- ${task.id}「${taskLabel(task)}」 ${status} (${suffix})${error}${last}\n  命令: ${task.command} · 目录: ${task.cwd || '.'}`;
          });
          return { text: `工作区: ${workspace.root}\n${rows.join('\n')}` };
        },
      }),
    );

    disposers.push(
      ctx.tools.register({
        name: 'dev_task_logs',
        description:
          '读取「快捷启动项」的运行日志：启动报错、运行中抛出的异常、端口占用、崩溃退出原因都在这里。' +
          '不传 taskId 时自动选最需要关注的那个（优先已失败的项目，其次正在运行的）。' +
          '默认读「本次启动」的日志；传 source="file" 可读磁盘上的完整历史（跨多次启动）。',
        parameters: {
          type: 'object',
          properties: {
            taskId: { type: 'string', description: '启动项 id；省略则自动选择。' },
            tail: { type: 'number', description: '读取最近多少行，默认 120，上限 800。' },
            onlyErrors: { type: 'boolean', description: '只返回被判定为错误的行，默认 false。' },
            source: {
              type: 'string',
              enum: ['memory', 'file'],
              description: 'memory（默认）只含本次启动；file 读磁盘上的完整历史日志。',
            },
          },
          additionalProperties: false,
        },
        output: {
          schema: { type: 'object', properties: { text: { type: 'string' } }, additionalProperties: false },
          render(_args, value) {
            return [{ type: 'text', text: String(value?.text ?? '') }];
          },
        },
        async execute(args, exec) {
          const directory = await directoryForTool(exec);
          const { workspace, tasks } = await listProjects(directory);
          if (tasks.length === 0) return { text: `工作区 ${workspace.root} 没有配置启动项。` };
          const existing = new Set(tasks.map(task => task.id));
          const requested = text(args?.taskId);
          if (requested && !existing.has(requested)) {
            return { text: `找不到启动项 ${requested}。可用的有: ${[...existing].join(', ')}` };
          }
          const targetId = requested || runner.focus(workspace.key)?.id;
          const task = tasks.find(item => item.id === targetId);
          const tail = Math.min(Math.max(Math.floor(Number(args?.tail) || 120), 1), 800);
          const runtime = targetId ? runner.get(workspace.key, targetId) : undefined;
          const file = runtime?.logFile ?? (task ? logFilePath(workspace, task) : undefined);

          if (args?.source === 'file') {
            if (!file) return { text: '没有可读取的日志文件：该启动项还没有运行过。' };
            const body = await readLogFileTail(file, tail);
            return { text: `# ${task ? taskLabel(task) : targetId} 完整日志文件\n${file}\n\n${body}` };
          }

          if (!targetId) {
            return { text: `工作区 ${workspace.root} 的启动项都还没启动过，没有日志。可先调用 dev_task_start。` };
          }
          const total = runner.count(workspace.key, targetId);
          const logs = runner.logs({ key: workspace.key, taskId: targetId, after: Math.max(0, total - tail), limit: tail });
          const header = task
            ? `# ${taskLabel(task)} (${task.id}) 状态=${runtime?.status ?? 'unknown'} 退出码=${runtime?.exitCode ?? '—'} 本次启动 ${total} 行`
            : `# ${targetId}`;
          const filtered = args?.onlyErrors
            ? logs.lines.filter(line => /\b(?:error|exception|fatal|failed|unhandled|EADDRINUSE|ELIFECYCLE)\b/iu.test(line.text))
            : logs.lines;
          const note = file ? `\n日志文件（含历史）: ${file}` : '';
          return { text: `${header}${note}\n${formatLines(filtered)}` };
        },
      }),
    );

    disposers.push(
      ctx.tools.register({
        name: 'dev_task_start',
        description:
          '启动一个用户已经配置好的「快捷启动项」。只能启动既有条目，不能新增或修改命令 —— 需要新条目时请让用户在界面上添加。',
        parameters: {
          type: 'object',
          properties: { taskId: { type: 'string', description: '启动项 id（来自 dev_task_list）。' } },
          required: ['taskId'],
          additionalProperties: false,
        },
        output: {
          schema: { type: 'object', properties: { text: { type: 'string' } }, additionalProperties: false },
          render(_args, value) {
            return [{ type: 'text', text: String(value?.text ?? '') }];
          },
        },
        async execute(args, exec) {
          const directory = await directoryForTool(exec);
          const started = await startTask({ directory, taskId: text(args?.taskId) });
          return { text: `已启动 ${started.task.id}（pid=${started.task.pid ?? '—'}），在 ${started.workspace} 下运行。稍后用 dev_task_logs 查看启动输出。` };
        },
      }),
    );

    disposers.push(
      ctx.tools.register({
        name: 'dev_task_stop',
        description: '停止一个正在运行的「快捷启动项」（会终止整棵子进程树）。',
        parameters: {
          type: 'object',
          properties: { taskId: { type: 'string', description: '启动项 id（来自 dev_task_list）。' } },
          required: ['taskId'],
          additionalProperties: false,
        },
        output: {
          schema: { type: 'object', properties: { text: { type: 'string' } }, additionalProperties: false },
          render(_args, value) {
            return [{ type: 'text', text: String(value?.text ?? '') }];
          },
        },
        async execute(args, exec) {
          const directory = await directoryForTool(exec);
          const stopped = await stopTask({ directory, taskId: text(args?.taskId) });
          return { text: `已停止 ${text(args?.taskId)}。` };
        },
      }),
    );

    return () => {
      for (const dispose of disposers) dispose();
    };
  }, 'dsh-dev-launcher: Agent 工具');
}
