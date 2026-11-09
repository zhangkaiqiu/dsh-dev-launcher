# dsh-dev-launcher

给 [DeepSeek Harness](https://github.com/deepseek-ai) 加一个「快捷启动」按钮：把项目的启动命令存下来，下次一键启停，输出实时可见 —— **并且会话能直接读到这些日志**，出问题不用再复制粘贴。

## 为什么

日常开发要在终端里敲 `npm run dev`、`java -jar ...`、`python app.py`，出错了还得把一屏日志贴给 AI。这个插件把这两件事合成一步：

- 启动项按工作区保存，切项目自动切换，不用每次重敲
- 会话通过工具直接读日志，报错定位从「复制粘贴」变成「它自己看」

## 功能

- **按工作区保存**启动项，配置存在 DSH 全局目录，换项目自动切
- **一键启停**，前端 / 后端 / mock 各自独立，可以同时跑
- **实时日志**，stdout 与 stderr 合并，stderr 行标红
- **日志落盘**，写到 `<工作区>/.tmp/dev-logs/<名称>-<任务ID>.log`
- **会话可读**，注册 4 个 Agent 工具（见下）
- **多 shell**：默认 `cmd.exe`，也可选 PowerShell 7 / Windows PowerShell 5 / Git Bash
- **面板可调宽**，左边缘拖动，宽度会记住

## 安装

从 GitHub 直接装：

```bash
dsh plugin --profile desktop add github:zhangkaiqiu/dsh-dev-launcher
```

`desktop` 是桌面版的 profile 名（命令行版用 `web`，改成你自己的 profile）。也可以锁 tag：

```bash
dsh plugin --profile desktop add github:zhangkaiqiu/dsh-dev-launcher#v0.1.0
```

更新用 `dsh plugin --profile desktop update dsh-dev-launcher`。装完重启 DSH —— client 半是
web 插件，刷新页面也能生效。

> `github:` 能装而目录依赖不行：pnpm 会按 `files` 把仓库打成包再硬链接进 profile，入口不会
> realpath 回源码盘，`peerDependencies` 自然只有一份。

本地开发时仍用 **tarball** 安装 —— 不能用 `link:` 或目录依赖。目录依赖会让 Node 把入口
realpath 回源码盘，`peerDependencies` 解析出第二份 `@deepseek-ai/dsh-llm`，宿主的
`instanceof LlmError` 判断失效，所有错误码退化成 `UNKNOWN`。

```bash
npm pack          # 生成 dsh-dev-launcher-0.1.0.tgz
```

然后在 DSH 的插件管理页安装这个 tgz。

## 使用

对话区右上角出现「快捷启动」按钮，点开面板：

1. **+ 新建启动项**，填名称和命令
2. 点「启动」，日志就在下方展开
3. 「停止」结束整个进程树（含 npm → cmd → node 这类多层子进程）

### 启动项字段

| 字段 | 说明 |
| --- | --- |
| 名称 | 显示用，如「前端」 |
| 命令 | 交给 shell 执行的完整命令行 |
| 工作目录 | 相对**工作区根目录**，默认 `.` 就是根目录 |
| 执行方式 | `系统默认(cmd.exe)` / `PowerShell 7` / `Windows PowerShell 5` / `Git Bash` |
| 环境变量 | 每行一个 `KEY=VALUE`，只对本启动项生效 |

不同 shell 的命令写法不同，选错会报语法错误：

```bash
# cmd.exe（默认）
npm run dev

# PowerShell
$env:NODE_ENV="development"; npm run dev

# Git Bash
NODE_ENV=development npm run dev
```

## 日志

每次启动**覆盖**上一次的文件，所以文件内容与界面上看到的一致：

```
<工作区>/.tmp/dev-logs/<名称>-<任务ID>.log
```

文件名带任务 ID，改名字或重名都不会互相覆盖。面板日志区右上角有「日志目录」按钮，直接打开资源管理器定位。

内存里只保留当前这次启动的最近 3000 行；文件在下次启动时被覆盖。

## 会话能做什么

插件注册了四个工具，会话可以直接调用：

| 工具 | 作用 |
| --- | --- |
| `dev_task_list` | 列出当前工作区的启动项与运行状态（含退出码、错误行数、最近一条错误） |
| `dev_task_logs` | 读日志。`source: "memory"`（默认）读本次启动，`source: "file"` 读磁盘上的完整内容 |
| `dev_task_start` | 启动一个启动项 |
| `dev_task_stop` | 停止一个启动项（终止整棵进程树） |

所以可以直接问：「服务怎么起不来了」「接口 500 了，看下后端日志」。

## 实现要点

- **Host 半** `index.js`：注册 HTTP 路由（同源 `fetch`）与 Agent 工具，负责配置读写、工作区解析、日志文件管理
- **Client 半** `client.js`：一个挂到 `conversation.session.header.utilities` 槽位的 React 组件，渲染按钮与浮层面板
- **`lib/runner.js`**：进程池，spawn、按行切分输出、状态机、进程树终止
- **`lib/store.js`**：按工作区持久化，串行写入 + 临时文件 rename，损坏文件自动备份

两个 Windows 上的坑值得记一笔：

1. `C:\Program Files\Git\bin\bash.exe` 是启动器，它 `_wexecv` 到 `usr\bin\bash.exe` 后就退出。Windows 没有真正的 exec，pid 会变，导致记录下来的 pid 早已作废、`taskkill` 打空。所以直接 spawn `usr\bin\bash.exe`。
2. `child.on('close')` 要等所有 stdio 管道关闭，孙进程握着管道时永远不触发。所以状态更新必须同时监听 `exit`，并用幂等的收尾函数兜底。

## 已知限制

- **重装插件会杀掉正在运行的任务**：插件卸载时会 dispose 进程池，顺带终止子进程。
- 配置只按工作区隔离，没有跨工作区的全局启动项。
- 没有进程自动重启 / 崩溃拉起。

## License

[MIT](./LICENSE)
