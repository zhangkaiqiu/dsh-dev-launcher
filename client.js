window.__ModuleLoader__.load({
  id: 'dsh-dev-launcher',
  factory(require) {
    const React = require('react');
    const { useCallback, useEffect, useMemo, useRef, useState } = React;
    const h = React.createElement;

    const STYLE_ID = 'dsh-dev-launcher-style';
    const API = '/dev-launcher';

    const ZH = {
      trigger: '快捷启动',
      title: '快捷启动',
      empty: '还没有配置启动项。添加一个脚本，之后一键就能起。',
      add: '新建启动项',
      addHint: '命令在工作区根目录下执行；「工作目录」填相对路径，默认 . 就是工作区根目录。',
      name: '名称',
      namePlaceholder: '前端 / 后端',
      command: '命令',
      commandPlaceholder: 'npm run dev',
      cwd: '工作目录',
      cwdPlaceholder: '相对工作区，默认 .',
      shell: '执行方式',
      shellDefault: '系统默认 (cmd.exe)',
      shellPwsh: 'PowerShell 7 (pwsh)',
      shellPowershell: 'Windows PowerShell 5',
      shellBash: 'Git Bash (bash)',
      shellHint: '需要 PowerShell 语法（如 $env:X=1）或 bash 语法时改这里，否则用默认的 cmd.exe。',
      env: '环境变量',
      envPlaceholder: 'NODE_ENV=development（每行一个）',
      save: '保存',
      cancel: '取消',
      edit: '编辑',
      remove: '删除',
      confirmRemove: '确认删除',
      start: '启动',
      stop: '停止',
      logs: '日志',
      back: '返回',
      running: '运行中',
      idle: '未启动',
      exited: '已退出',
      stopped: '已停止',
      failed: '已失败',
      noLogs: '还没有输出。',
      unknownTask: '没有可显示的启动项',
      loadFailed: '读取配置失败',
      refresh: '刷新',
      openLogDir: '日志目录',
      dragHint: '拖动调整宽度',
    };

    const EN = {
      trigger: 'Launcher',
      title: 'Quick launcher',
      empty: 'No launch scripts yet. Add one and start it with a single click.',
      add: 'New script',
      addHint: 'The command runs in the workspace root; Directory is relative to it (default . is the root).',
      name: 'Name',
      namePlaceholder: 'web / api',
      command: 'Command',
      commandPlaceholder: 'npm run dev',
      cwd: 'Directory',
      cwdPlaceholder: 'Relative to the workspace; default .',
      shell: 'Shell',
      shellDefault: 'System default (cmd.exe)',
      shellPwsh: 'PowerShell 7 (pwsh)',
      shellPowershell: 'Windows PowerShell 5',
      shellBash: 'Git Bash (bash)',
      shellHint: 'Pick PowerShell or bash when the command needs its syntax (e.g. $env:X=1); otherwise keep cmd.exe.',
      env: 'Environment',
      envPlaceholder: 'NODE_ENV=development (one per line)',
      save: 'Save',
      cancel: 'Cancel',
      edit: 'Edit',
      remove: 'Delete',
      confirmRemove: 'Confirm delete',
      start: 'Start',
      stop: 'Stop',
      logs: 'Logs',
      back: 'Back',
      running: 'Running',
      idle: 'Idle',
      exited: 'Exited',
      stopped: 'Stopped',
      failed: 'Failed',
      noLogs: 'No output yet.',
      unknownTask: 'No launcher to show',
      loadFailed: 'Failed to load configuration',
      refresh: 'Refresh',
      openLogDir: 'Log folder',
      dragHint: 'Drag to resize',
    };

    const CSS = `
.dl-trigger{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 9px;border-radius:8px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:12px;line-height:1;font-family:inherit;transition:background .12s,color .12s;}
.dl-trigger:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}
.dl-trigger[data-active="true"]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l1);}
.dl-trigger-icon{font-size:13px;line-height:1;}
.dl-count{display:inline-flex;align-items:center;justify-content:center;min-width:15px;height:15px;padding:0 4px;border-radius:8px;background:var(--dsw-alias-state-success-primary);color:#fff;font-size:10px;font-weight:600;}
.dl-panel{position:fixed;z-index:1200;max-width:calc(100vw - 24px);max-height:78vh;display:flex;flex-direction:column;border-radius:12px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-overlay);box-shadow:0 14px 38px rgba(0,0,0,.2);overflow:hidden;font-size:13px;color:var(--dsw-alias-label-primary);font-family:inherit;}
.dl-panel[data-resizing="true"]{user-select:none;cursor:col-resize;}
.dl-resize{position:absolute;left:0;top:0;bottom:0;width:7px;cursor:col-resize;z-index:3;}
.dl-resize:hover{background:var(--dsw-alias-brand-primary);opacity:.3;}
.dl-confirm{display:flex;gap:6px;}
.dl-head{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:0 0 auto;}
.dl-title{font-size:13px;font-weight:600;}
.dl-scope{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-secondary);max-width:230px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dl-body{padding:8px;overflow:auto;flex:1 1 auto;min-height:0;}
.dl-row{display:flex;align-items:center;gap:9px;padding:9px 10px;border-radius:9px;}
.dl-row:hover{background:var(--dsw-alias-bg-layer-2);}
.dl-row[data-selected="true"]{background:var(--dsw-alias-bg-layer-2);}
.dl-dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--dsw-alias-state-idle-primary);}
.dl-dot[data-status="running"]{background:var(--dsw-alias-state-success-primary);}
.dl-dot[data-status="failed"]{background:var(--dsw-alias-state-error-primary);}
.dl-dot[data-status="exited"],.dl-dot[data-status="stopped"]{background:var(--dsw-alias-state-warn-primary);}
.dl-meta{min-width:0;flex:1;}
.dl-name{font-size:12.5px;font-weight:500;display:flex;align-items:center;gap:6px;}
.dl-state{font-size:11px;font-weight:400;color:var(--dsw-alias-label-secondary);}
.dl-state[data-status="failed"]{color:var(--dsw-alias-state-error-primary);}
.dl-state[data-status="running"]{color:var(--dsw-alias-state-success-primary);}
.dl-cmd{font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,Consolas,monospace;}
.dl-actions{display:flex;gap:6px;flex:none;}
.dl-mini{height:24px;padding:0 10px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:11.5px;cursor:pointer;font-family:inherit;}
.dl-mini:hover{background:var(--dsw-alias-bg-layer-2);}
.dl-mini[data-primary="true"]{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff;}
.dl-mini[data-danger="true"]{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);}
.dl-mini:disabled{opacity:.5;cursor:default;}
.dl-empty{padding:22px 14px;text-align:center;font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.7;}
.dl-foot{border-top:1px solid var(--dsw-alias-border-l1);padding:8px 10px;display:flex;justify-content:space-between;align-items:center;gap:8px;flex:0 0 auto;}
.dl-error{margin:8px 10px;padding:7px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-state-error-primary);font-size:11.5px;line-height:1.5;word-break:break-word;}
.dl-form{display:flex;flex-direction:column;gap:9px;padding:4px 6px 8px;}
.dl-field{display:flex;flex-direction:column;gap:4px;}
.dl-label{font-size:11px;color:var(--dsw-alias-label-secondary);}
.dl-input,.dl-textarea{width:100%;box-sizing:border-box;border-radius:7px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:12px;font-family:inherit;padding:6px 8px;}
.dl-input{height:30px;}
.dl-select{height:32px;padding:0 6px;cursor:pointer;}
.dl-textarea{min-height:58px;resize:vertical;font-family:ui-monospace,Consolas,monospace;font-size:11.5px;}
.dl-hint{font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.5;}
.dl-form-actions{display:flex;gap:8px;justify-content:flex-end;}
.dl-logs{border-top:1px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column;min-height:0;flex:0 0 auto;}
.dl-logs-head{display:flex;align-items:center;gap:8px;padding:7px 12px;font-size:11.5px;color:var(--dsw-alias-label-secondary);overflow:hidden;}
.dl-logs-head>*{flex:none;}
.dl-logs-head .dl-logpath{flex:0 1 auto;}
.dl-logpath{font-size:10.5px;font-family:ui-monospace,Consolas,monospace;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:210px;}
.dl-logbox{max-height:340px;overflow:auto;padding:8px 12px 12px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11.5px;line-height:1.55;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);}
.dl-logline[data-stream="err"]{color:var(--dsw-alias-state-error-primary);}
.dl-logline[data-hot="true"]{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);}
`;

    function installStyles() {
      if (typeof document === 'undefined') return () => {};
      const existing = document.getElementById(STYLE_ID);
      if (existing) return () => {};
      const element = document.createElement('style');
      element.id = STYLE_ID;
      element.textContent = CSS;
      document.head.appendChild(element);
      return () => element.remove();
    }

    const STATUS_KEY = {
      idle: 'idle',
      running: 'running',
      exited: 'exited',
      stopped: 'stopped',
      failed: 'failed',
    };

    function formatDuration(milliseconds) {
      const seconds = Math.max(0, Math.floor(milliseconds / 1000));
      if (seconds < 60) return `${seconds}s`;
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return `${minutes}m${seconds % 60}s`;
      return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
    }

    function parseEnv(text) {
      const env = {};
      for (const raw of String(text ?? '').split(/\r?\n/u)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const index = line.indexOf('=');
        if (index <= 0) continue;
        env[line.slice(0, index).trim()] = line.slice(index + 1).trim();
      }
      return env;
    }

    function formatEnv(env) {
      return Object.entries(env ?? {}).map(([key, value]) => `${key}=${value}`).join('\n');
    }

    function LogBox({ lines, t }) {
      const ref = useRef(null);
      useEffect(() => {
        const element = ref.current;
        if (element) element.scrollTop = element.scrollHeight;
      }, [lines]);
      if (lines.length === 0) {
        return h('div', { className: 'dl-logbox' }, h('span', { style: { opacity: 0.6 } }, t('noLogs')));
      }
      return h(
        'div',
        { className: 'dl-logbox', ref },
        lines.map(line =>
          h(
            'div',
            {
              key: line.n,
              className: 'dl-logline',
              'data-stream': line.s,
              'data-hot': line.s === 'err' ? 'true' : undefined,
            },
            line.text,
          ),
        ),
      );
    }

    function LauncherEntry(props) {
      const t = props.t ?? (key => ZH[key] ?? key);
      const sessionId = props.sessionId;

      const [open, setOpen] = useState(false);
      const [anchor, setAnchor] = useState({ top: 64, right: 24 });
      const [workspace, setWorkspace] = useState(null);
      const [tasks, setTasks] = useState([]);
      const [error, setError] = useState('');
      const [selectedId, setSelectedId] = useState(null);
      const [logs, setLogs] = useState([]);
      const [view, setView] = useState('list');
      const [form, setForm] = useState(null);
      const [busy, setBusy] = useState('');
      const [confirmId, setConfirmId] = useState(null);
      const [, setClock] = useState(0);

      const buttonRef = useRef(null);
      const panelRef = useRef(null);

      const request = useCallback(async (path, body) => {
        const response = await fetch(`${API}${path}`, {
          method: body === undefined ? 'GET' : 'POST',
          headers: body === undefined ? undefined : { 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const payload = await response.json().catch(() => null);
        if (!payload) throw new Error('宿主没有返回有效数据');
        if (!payload.ok) throw new Error(payload.error || '请求失败');
        return payload.value;
      }, []);

      const refresh = useCallback(async () => {
        if (!sessionId) return;
        try {
          const value = await request(`/state?sessionId=${encodeURIComponent(sessionId)}`);
          setWorkspace(value.workspace ?? null);
          setTasks(Array.isArray(value.tasks) ? value.tasks : []);
          setError('');
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      }, [request, sessionId]);

      useEffect(() => {
        void refresh();
        const timer = setInterval(() => {
          void refresh();
        }, open ? 2000 : 8000);
        return () => clearInterval(timer);
      }, [refresh, open]);

      const runningCount = useMemo(
        () => tasks.filter(task => task.runtime?.status === 'running').length,
        [tasks],
      );

      useEffect(() => {
        if (!open || runningCount === 0) return undefined;
        const timer = setInterval(() => setClock(value => value + 1), 1000);
        return () => clearInterval(timer);
      }, [open, runningCount]);

      useEffect(() => {
        if (!open || !selectedId || !sessionId || view !== 'list') return undefined;
        let cancelled = false;
        let after = -1;
        let knownRun = null;
        setLogs([]);

        const pull = async from => {
          const value = await request(
            `/logs?sessionId=${encodeURIComponent(sessionId)}&taskId=${encodeURIComponent(selectedId)}&after=${from}&limit=500`,
          );
          return value ?? {};
        };

        const tick = async () => {
          try {
            const value = await pull(after);
            if (cancelled) return;
            const run = value.runId ?? null;
            // 换了一代（停止后重新启动）：行号从头开始，必须清空面板并重读。
            if (knownRun !== null && run !== knownRun) {
              knownRun = run;
              after = 0;
              setLogs([]);
              const fresh = await pull(0);
              if (cancelled) return;
              setLogs(Array.isArray(fresh.lines) ? fresh.lines : []);
              after = typeof fresh.next === 'number' ? fresh.next : 0;
              return;
            }
            knownRun = run;
            if (Array.isArray(value.lines) && value.lines.length > 0) {
              setLogs(previous => previous.concat(value.lines).slice(-3000));
            }
            after = typeof value.next === 'number' ? value.next : after;
          } catch {
            // 日志拉取失败不覆盖主视图错误，避免刷屏。
          }
        };
        void tick();
        const timer = setInterval(tick, 900);
        return () => {
          cancelled = true;
          clearInterval(timer);
        };
      }, [open, selectedId, sessionId, request, view]);

      useEffect(() => {
        if (!open) return undefined;
        const onPointerDown = event => {
          const target = event.target;
          if (panelRef.current?.contains(target)) return;
          if (buttonRef.current?.contains(target)) return;
          setOpen(false);
        };
        const onKeyDown = event => {
          if (event.key === 'Escape') setOpen(false);
        };
        document.addEventListener('mousedown', onPointerDown, true);
        document.addEventListener('keydown', onKeyDown, true);
        return () => {
          document.removeEventListener('mousedown', onPointerDown, true);
          document.removeEventListener('keydown', onKeyDown, true);
        };
      }, [open]);

      const toggle = useCallback(() => {
        if (!open && buttonRef.current) {
          const rect = buttonRef.current.getBoundingClientRect();
          setAnchor({
            top: Math.round(rect.bottom + 8),
            right: Math.max(12, Math.round(window.innerWidth - rect.right)),
          });
        }
        setOpen(value => !value);
      }, [open]);

      const [width, setWidth] = useState(() => {
        try {
          const saved = Number(window.localStorage.getItem('dsh-dev-launcher-width'));
          if (Number.isFinite(saved) && saved >= 480 && saved <= 1600) return saved;
        } catch {
          // localStorage 不可用时用默认宽度。
        }
        return 960;
      });
      const [resizing, setResizing] = useState(false);

      const beginResize = useCallback(
        event => {
          if (event.button !== 0) return;
          event.preventDefault();
          const startX = event.clientX;
          const startWidth = width;
          setResizing(true);
          const onMove = moveEvent => {
            // 面板右边贴着窗口右侧，向左拖才是变宽。
            setWidth(Math.min(1600, Math.max(480, startWidth + (startX - moveEvent.clientX))));
          };
          const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            setResizing(false);
            setWidth(current => {
              try {
                window.localStorage.setItem('dsh-dev-launcher-width', String(current));
              } catch {
                // 持久化失败不影响本次调整。
              }
              return current;
            });
          };
          document.addEventListener('mousemove', onMove);
          document.addEventListener('mouseup', onUp);
        },
        [width],
      );

      const act = useCallback(
        async (path, taskId) => {
          setBusy(taskId);
          setError('');
          try {
            await request(path, { sessionId, taskId });
            await refresh();
          } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
          } finally {
            setBusy('');
          }
        },
        [refresh, request, sessionId],
      );

      const openForm = useCallback(task => {
        setForm(
          task
            ? {
                id: task.id,
                name: task.name,
                command: task.command,
                cwd: task.cwd,
                shell: task.shell ?? 'default',
                envText: formatEnv(task.env),
              }
            : { id: '', name: '', command: '', cwd: '.', shell: 'default', envText: '' },
        );
        setView('form');
        setError('');
      }, []);

      const submitForm = useCallback(async () => {
        if (!form) return;
        if (!form.command.trim()) {
          setError('命令不能为空');
          return;
        }
        setBusy('form');
        try {
          await request('/save', {
            sessionId,
            task: {
              id: form.id || undefined,
              name: form.name,
              command: form.command,
              cwd: form.cwd,
              shell: form.shell,
              env: parseEnv(form.envText),
            },
          });
          setForm(null);
          setView('list');
          await refresh();
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
          setBusy('');
        }
      }, [form, refresh, request, sessionId]);

      const removeTask = useCallback(
        async taskId => {
          setBusy(taskId);
          try {
            await request('/delete', { sessionId, taskId });
            if (selectedId === taskId) setSelectedId(null);
            setConfirmId(null);
            await refresh();
          } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
          } finally {
            setBusy('');
          }
        },
        [refresh, request, selectedId, sessionId],
      );

      const openLogDir = useCallback(async () => {
        try {
          await request('/reveal', { sessionId });
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      }, [request, sessionId]);

      const trigger = h(
        'button',
        {
          ref: buttonRef,
          type: 'button',
          className: 'dl-trigger',
          'data-active': open ? 'true' : 'false',
          title: t('trigger'),
          onClick: toggle,
        },
        h('span', { className: 'dl-trigger-icon', 'aria-hidden': 'true' }, '▶'),
        h('span', null, t('trigger')),
        runningCount > 0 ? h('span', { className: 'dl-count' }, String(runningCount)) : null,
      );

      if (!open) return trigger;

      const panelHead = h(
        'div',
        { className: 'dl-head' },
        h('span', { className: 'dl-title' }, t('title')),
        h('span', { className: 'dl-scope', title: workspace?.root ?? '' }, workspace?.title ?? workspace?.root ?? ''),
      );

      let body;
      if (view === 'form' && form) {
        body = h(
          'div',
          { className: 'dl-form' },
          h(
            'div',
            { className: 'dl-field' },
            h('span', { className: 'dl-label' }, t('name')),
            h('input', {
              className: 'dl-input',
              value: form.name,
              placeholder: t('namePlaceholder'),
              onChange: event => setForm({ ...form, name: event.target.value }),
            }),
          ),
          h(
            'div',
            { className: 'dl-field' },
            h('span', { className: 'dl-label' }, t('command')),
            h('input', {
              className: 'dl-input',
              value: form.command,
              placeholder: t('commandPlaceholder'),
              spellCheck: false,
              onChange: event => setForm({ ...form, command: event.target.value }),
            }),
          ),
          h(
            'div',
            { className: 'dl-field' },
            h('span', { className: 'dl-label' }, t('cwd')),
            h('input', {
              className: 'dl-input',
              value: form.cwd,
              placeholder: t('cwdPlaceholder'),
              spellCheck: false,
              onChange: event => setForm({ ...form, cwd: event.target.value }),
            }),
          ),
          h(
            'div',
            { className: 'dl-field' },
            h('span', { className: 'dl-label' }, t('shell')),
            h(
              'select',
              {
                className: 'dl-input dl-select',
                value: form.shell,
                onChange: event => setForm({ ...form, shell: event.target.value }),
              },
              h('option', { value: 'default' }, t('shellDefault')),
              h('option', { value: 'pwsh' }, t('shellPwsh')),
              h('option', { value: 'powershell' }, t('shellPowershell')),
              h('option', { value: 'bash' }, t('shellBash')),
            ),
            h('span', { className: 'dl-hint' }, t('shellHint')),
          ),
          h(
            'div',
            { className: 'dl-field' },
            h('span', { className: 'dl-label' }, t('env')),
            h('textarea', {
              className: 'dl-textarea',
              value: form.envText,
              placeholder: t('envPlaceholder'),
              spellCheck: false,
              onChange: event => setForm({ ...form, envText: event.target.value }),
            }),
          ),
          h('div', { className: 'dl-hint' }, t('addHint')),
          h(
            'div',
            { className: 'dl-form-actions' },
            h(
              'button',
              {
                type: 'button',
                className: 'dl-mini',
                onClick: () => {
                  setForm(null);
                  setView('list');
                },
              },
              t('cancel'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dl-mini',
                'data-primary': 'true',
                disabled: busy === 'form',
                onClick: submitForm,
              },
              t('save'),
            ),
          ),
        );
      } else if (tasks.length === 0) {
        body = h('div', { className: 'dl-empty' }, t('empty'));
      } else {
        body = h(
          'div',
          null,
          tasks.map(task => {
            const runtime = task.runtime;
            const status = runtime?.status ?? 'idle';
            const elapsed = status === 'running' && runtime?.startedAt ? ` · ${formatDuration(Date.now() - runtime.startedAt)}` : '';
            const exit = status === 'failed' || status === 'exited' ? ` · code ${runtime?.exitCode ?? '—'}` : '';
            return h(
              'div',
              { key: task.id, className: 'dl-row', 'data-selected': selectedId === task.id ? 'true' : 'false' },
              h('span', { className: 'dl-dot', 'data-status': status }),
              h(
                'div',
                { className: 'dl-meta' },
                h(
                  'div',
                  { className: 'dl-name' },
                  task.name || task.command,
                  h('span', { className: 'dl-state', 'data-status': status }, `${t(STATUS_KEY[status] ?? 'idle')}${elapsed}${exit}`),
                ),
                h(
                  'div',
                  {
                    className: 'dl-cmd',
                    title: `${task.command} · ${task.cwd}${task.shell && task.shell !== 'default' ? ` · ${task.shell}` : ''}`,
                  },
                  `${task.command} · ${task.cwd}${task.shell && task.shell !== 'default' ? ` · ${task.shell}` : ''}`,
                ),
              ),
              h(
                'div',
                { className: 'dl-actions' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dl-mini',
                    disabled: busy === task.id,
                    'data-danger': status === 'running' ? 'true' : undefined,
                    'data-primary': status === 'running' ? undefined : 'true',
                    onClick: () => {
                      setConfirmId(null);
                      void act(status === 'running' ? '/stop' : '/start', task.id);
                    },
                  },
                  status === 'running' ? t('stop') : t('start'),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dl-mini',
                    onClick: () => {
                      setConfirmId(null);
                      setSelectedId(current => (current === task.id ? null : task.id));
                      setView('list');
                    },
                  },
                  t('logs'),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dl-mini',
                    onClick: () => {
                      setConfirmId(null);
                      openForm(task);
                    },
                  },
                  t('edit'),
                ),
                confirmId === task.id
                  ? h(
                      'span',
                      { className: 'dl-confirm' },
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dl-mini',
                          'data-danger': 'true',
                          disabled: busy === task.id,
                          onClick: () => removeTask(task.id),
                        },
                        t('confirmRemove'),
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dl-mini',
                          onClick: () => setConfirmId(null),
                        },
                        t('cancel'),
                      ),
                    )
                  : h(
                      'button',
                      {
                        type: 'button',
                        className: 'dl-mini',
                        'data-danger': 'true',
                        disabled: busy === task.id,
                        onClick: () => setConfirmId(task.id),
                      },
                      t('remove'),
                    ),
              ),
            );
          }),
        );
      }

      const foot = h(
        'div',
        { className: 'dl-foot' },
        h(
          'button',
          { type: 'button', className: 'dl-mini', onClick: () => openForm(null) },
          `+ ${t('add')}`,
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'dl-mini',
            onClick: () => {
              void refresh();
            },
          },
          t('refresh'),
        ),
      );

      const selectedTask = selectedId ? tasks.find(task => task.id === selectedId) : undefined;
      const selectedLogFile = selectedTask?.logFile ?? null;
      const logSection =
        selectedId && view === 'list'
          ? h(
              'div',
              { className: 'dl-logs' },
              h(
                'div',
                { className: 'dl-logs-head' },
                h('span', null, `${t('logs')} · ${selectedTask?.name ?? selectedId}`),
                h(
                  'code',
                  { className: 'dl-logpath', title: selectedLogFile ?? workspace?.logDir ?? '' },
                  selectedLogFile ?? workspace?.logDir ?? '',
                ),
                h(
                  'button',
                  { type: 'button', className: 'dl-mini', style: { marginLeft: 'auto' }, onClick: openLogDir },
                  t('openLogDir'),
                ),
                h(
                  'button',
                  { type: 'button', className: 'dl-mini', onClick: () => setSelectedId(null) },
                  t('back'),
                ),
              ),
              h(LogBox, { lines: logs, t }),
            )
          : null;

      const panel = h(
        'div',
        {
          ref: panelRef,
          className: 'dl-panel',
          'data-resizing': resizing ? 'true' : undefined,
          style: { top: `${anchor.top}px`, right: `${anchor.right}px`, width: `${width}px` },
          role: 'dialog',
          'aria-label': t('title'),
        },
        h('div', { className: 'dl-resize', title: t('dragHint'), onMouseDown: beginResize }),
        panelHead,
        error ? h('div', { className: 'dl-error' }, `${t('loadFailed')}: ${error}`) : null,
        h('div', { className: 'dl-body' }, body),
        logSection,
        view === 'list' ? foot : null,
      );

      return h(React.Fragment, null, trigger, panel);
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 激活路径全部兜底：任何一步失败都只记录、不外抛。
        // cordis 会把 apply 的异常吞成 fiber 的 failed 状态，而 web boot 见到
        // 任何 failed 都会整体报错，所以这里绝不能让异常逃出去。
        console.error('[dsh-dev-launcher] apply enter');

        try {
          ctx.effect(installStyles, 'dsh-dev-launcher: styles');
        } catch (error) {
          console.error('[dsh-dev-launcher] styles failed:', error);
        }

        // locale 不是必需服务：新版 DSH 对未注入的服务访问可能抛错，取不到就用内置中文。
        let locale = null;
        try {
          locale = (typeof ctx.get === 'function' ? ctx.get('locale') : undefined) ?? ctx.locale ?? null;
        } catch (error) {
          console.error('[dsh-dev-launcher] locale unavailable:', error);
          locale = null;
        }

        let translate = null;
        if (locale && typeof locale.bind === 'function') {
          try {
            translate = locale.bind('dev-launcher');
          } catch (error) {
            console.error('[dsh-dev-launcher] locale.bind failed:', error);
          }
        }

        if (locale && typeof locale.register === 'function') {
          try {
            ctx.effect(() => {
              // register 在重复激活（HMR / web boot 重试）时抛 already-has-locale，
              // 那属于幂等噪音，吞掉即可。
              const handle = locale.register('dev-launcher', { zh: ZH, en: EN });
              return typeof handle === 'function' ? handle : () => {};
            }, 'dsh-dev-launcher: locale');
          } catch (error) {
            console.error('[dsh-dev-launcher] locale.register failed:', error);
          }
        }

        try {
          ctx.slots.inject('conversation.session.header.utilities', () =>
            ctx.slots.register(
              {
                name: 'conversation.session.header.utilities',
                id: 'dev-launcher',
                order: 30,
                label: () => (translate ? translate('trigger') : ZH.trigger),
                inject: () => ({
                  t: key => {
                    try {
                      const value = translate?.(key);
                      return typeof value === 'string' && value && value !== key ? value : (ZH[key] ?? key);
                    } catch {
                      return ZH[key] ?? key;
                    }
                  },
                }),
              },
              LauncherEntry,
            ),
          );
        } catch (error) {
          console.error('[dsh-dev-launcher] slots failed:', error);
        }

        console.error('[dsh-dev-launcher] apply done');
      },
    };
  },
});
