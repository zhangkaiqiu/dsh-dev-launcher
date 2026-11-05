/**
 * 按工作区持久化「快捷启动项」。
 *
 * 存储位置由插件传入（默认 $DSH_HOME/dev-launcher/tasks.json），
 * 结构：{ version, workspaces: { "<normalized root>": { root, tasks: [...] } } }。
 * 所有写入走串行队列 + 临时文件 rename，避免并发交错与半截文件。
 */

import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const STORE_VERSION = 1;

const MAX_TASKS_PER_WORKSPACE = 32;
const MAX_NAME = 80;
const MAX_COMMAND = 2000;
const MAX_ENV_ENTRIES = 32;

/** Windows 文件系统大小写不敏感，统一用规范化的绝对路径做键。 */
export function workspaceKey(root) {
  const resolved = path.resolve(root);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function text(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback;
}

const SHELL_MODES = new Set(['default', 'cmd', 'powershell', 'pwsh', 'bash']);

function pickShell(value) {
  const mode = text(value).toLowerCase();
  return SHELL_MODES.has(mode) ? mode : 'default';
}

function cleanEnv(raw) {
  const env = {};
  if (raw === undefined || raw === null) return env;
  const entries = Array.isArray(raw) ? raw : typeof raw === 'object' ? Object.entries(raw) : [];
  let count = 0;
  for (const entry of entries) {
    if (count >= MAX_ENV_ENTRIES) break;
    const [key, value] = Array.isArray(entry) ? entry : [undefined, undefined];
    if (typeof key !== 'string' || !key.trim()) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key.trim())) continue;
    env[key.trim()] = typeof value === 'string' ? value : String(value ?? '');
    count += 1;
  }
  return env;
}

function newTaskId() {
  return `t${randomBytes(4).toString('hex')}`;
}

/** 只保留已知字段，避免配置里夹带任意属性。 */
export function cleanTask(raw, { keepId = true } = {}) {
  if (!raw || typeof raw !== 'object') return undefined;
  const command = text(raw.command).slice(0, MAX_COMMAND);
  if (!command) return undefined;
  const id = keepId ? text(raw.id) : '';
  return {
    id: /^[A-Za-z0-9_-]{1,48}$/u.test(id) ? id : newTaskId(),
    name: (text(raw.name) || command).slice(0, MAX_NAME),
    command,
    cwd: text(raw.cwd) || '.',
    shell: pickShell(raw.shell),
    env: cleanEnv(raw.env),
  };
}

function normalize(raw) {
  const workspaces = {};
  const source = raw && typeof raw === 'object' ? raw.workspaces : undefined;
  if (source && typeof source === 'object') {
    for (const [key, value] of Object.entries(source)) {
      if (!value || typeof value !== 'object') continue;
      const root = text(value.root) || key;
      const tasks = Array.isArray(value.tasks)
        ? value.tasks.map(task => cleanTask(task)).filter(Boolean).slice(0, MAX_TASKS_PER_WORKSPACE)
        : [];
      workspaces[key] = { root, tasks };
    }
  }
  return { version: STORE_VERSION, workspaces };
}

export function createStore({ dir }) {
  const file = path.join(dir, 'tasks.json');
  let cache;
  let queue = Promise.resolve();

  function serialize(operation) {
    const run = queue.then(operation, operation);
    queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async function load() {
    if (cache) return cache;
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'));
      cache = normalize(parsed);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        cache = normalize(undefined);
      } else if (error instanceof SyntaxError) {
        // 配置文件损坏：留一份备份再重置，避免静默丢配置也避免永久起不来。
        const backup = `${file}.corrupt-${Date.now()}.json`;
        await rename(file, backup).catch(() => undefined);
        cache = normalize(undefined);
        console.warn(`[dsh-dev-launcher] tasks.json 无法解析，已备份到 ${backup}`);
      } else {
        throw error;
      }
    }
    return cache;
  }

  async function persist() {
    await mkdir(dir, { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
    await rename(temporary, file);
  }

  function entry(key, root) {
    if (!cache.workspaces[key]) cache.workspaces[key] = { root, tasks: [] };
    return cache.workspaces[key];
  }

  return {
    /** 某个工作区的配置快照；不会顺手创建空条目。 */
    async read(key) {
      const data = await load();
      const workspace = data.workspaces[key];
      return workspace ? { root: workspace.root, tasks: workspace.tasks.map(task => ({ ...task })) } : { root: undefined, tasks: [] };
    },

    async saveTask({ key, root, task }) {
      const next = cleanTask(task, { keepId: true });
      if (!next) throw new Error('启动项缺少 command');
      return serialize(async () => {
        await load();
        const workspace = entry(key, root);
        const index = workspace.tasks.findIndex(item => item.id === next.id);
        if (index >= 0) {
          workspace.tasks[index] = next;
        } else {
          if (workspace.tasks.length >= MAX_TASKS_PER_WORKSPACE) throw new Error(`该工作区最多 ${MAX_TASKS_PER_WORKSPACE} 个启动项`);
          workspace.tasks.push(next);
        }
        await persist();
        return { ...next };
      });
    },

    async deleteTask({ key, taskId }) {
      return serialize(async () => {
        await load();
        const workspace = cache.workspaces[key];
        if (!workspace) return false;
        const index = workspace.tasks.findIndex(item => item.id === taskId);
        if (index < 0) return false;
        workspace.tasks.splice(index, 1);
        await persist();
        return true;
      });
    },
  };
}
