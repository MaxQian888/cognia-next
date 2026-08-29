---
title: ADR-0039 — 集成终端 Phase 4 — 仿 Copilot 的 AI 自动补全、脚本类型运行器、插件补全提供方
description: "第四阶段将集成终端（ADR-0031/0033）转变为辅助开发终端。（1） GitHub-Copilot-style内联自动补全：当你在shell提示输入时，去掉的建议会以光标后显现为暗淡的幽灵文本;Tab/→接受（将后缀写入PTY——绝不自动运行），Esc关闭。该引擎为渲染器纯粹（行缓冲模型、提供商注册表、排名、提示词构建器），内置离线历史提供商和内置LLM 提供商，通过选择加入设置+PII遮蔽门禁进行限制。（2）脚本类运行器将文件extension/shebang映射到正确的解释器（.sh→bash、.ps1→pwsh -File、.py→python3等）。（3） 所有这些都暴露在插件之下：ctx.terminal 获得 registerCompletionProvider / runScript / detectScriptType，新的 terminal：completion 权限，以及连接进模块-桥调度terminalCompletionProviders懒桥的清单。"
---

# ADR-0039 — 集成终端 Phase 4

**状态**：已接受（2026-06-01）**作者**：Max Qian + Claude作品4.8**超前*：扩展ADR-0031+ADR-0033（不替代）;实现ADR-0033后续#4（“AI 命令协助——设计而非制造”）**影响**：`lib/terminal/completion/`、`lib/terminal/script-runner.ts`、`lib/terminal/shell-detect.ts`、`hooks/terminal/`、`components/terminal/terminal-instance.tsx`、`components/terminal/terminal-ghost-text.tsx`、`components/settings/terminal/terminal-card.tsx`、`lib/plugin/api/terminal-api.ts`、`lib/plugin/bridge/terminal-completion-bridge.ts`、`lib/plugin/contracts/module-bridge-map.ts`、`lib/plugin/core/validation.ts`、`lib/plugin/security/permission-guard.ts`、`types/plugin/plugin.ts`、`types/plugin/plugin-terminal-completion.ts`、`lib/claude/types.ts`、`crates/cognia-cli/src/cmd_lint.rs`、`i18n/messages/{en,zh-CN}.json`

## 当前状态修订（2026-08-13）

Inline explain/fix 已交付。Mobile autocomplete 继续依赖 ADR-0031 的 canonical OSC 633 cwd/command event stream；后续复用当前 completion engine，不新增 mobile-only engine。

## 背景

ADR-0031/0033 发布了完整的集成终端（xterm.js 底座、`portable-pty`后端、OSC 633 标记、移动WS 传输、分割面板、命令导航、载入-还原、链接到编辑器），以及一波承诺的 shell 功能打磨（shell picker、启动配置文件、配色方案、渲染选项UTF-8代码页修复）。但仍有两个缺口：

1. **无命令协助。**ADR-0033后续#4明确推迟“AI 命令码头协助（解释错误/建议修正）”。
2. **没有脚本类型的感知。** 运行脚本文件意味着用户必须拼写解释器;终端只知道 shell *二进制*，不懂*脚本类型*。

跨项目规则是终端功能必须暴露给插件（`ctx.terminal`已经有`spawn/write/kill/onData/readRecent/list`）。

该阶段提供GitHub-Copilot-style的内联自动补全、脚本型运行器以及插件接口——同时保证隐私和权限严谨。

## 决策

### D1 — 渲染器纯完备引擎（`lib/terminal/completion/`）

建议流水线中所有可被排除在 React + xterm 之外，因此繁琐部分会被单独进行单元测试：

- **`line-buffer.ts`** — 一个尽力而为的*当前输入行*模型，纯粹由按键流xterm的`onData`输出构建。真实的行编辑发生在shell（readline/PSReadLine），并以*output*回应，我们无法可靠读取，因此我们跟踪一个并行模型：可打印运行插入光标;退格/Ctrl-U/K/W编辑;箭头移动;Enter/Ctrl-C重置。关键是，任何我们*无法*建模的输入——历史回忆（↑/↓）、shell制表补全、反向搜索、括号粘贴——都会将行翻转为`tracked: false`，建议会被抑制，直到下一个提示边界。这就是防止陈旧幽灵覆盖错误内容的安全阀。
- **`prompt.ts`** — 纯提示构建器（shell、platform、cwd、近期 命令、部分输入）+ `sanitizeCompletion`，剥离fences/backticks/prompt-echo，取第一行，保证结果扩展输入。`ghostSuffix`计算光标后显示的暗文本。
- **`registry.ts`**——模块级提供商注册表（镜像`extension-api`）。`getCompletions`在每提供商超时+错误隔离后，同时向所有提供商扇化上下文，然后合并，文本去重，排名`plugin > ai > history`，再按分数排序。
- **`history-provider.ts`** — 内置、离线、始终可用：前缀匹配会话最近的命令历史。这是当没有模型配置时的优雅降级路径。
- **`ai-provider.ts`** — 内置LLM 提供商（副驾驶Brain）。构建提示词，**PII-gates** 在任何模型调用前用`hasNoLeakingPii`组装上下文`(shell, cwd, input)`，通过简短TTL记忆（包括负缓存），如果呼叫者信号中断则丢弃结果。
- **`controller.ts`**——无React的编排Brain：消耗按键，去反弹查询，保持在输入过程中仍然有效的建议（后缀匹配时不重新查询），防止过时的异步结果，并暴露`accept()`（返回后缀写入——从不自动提交）/ `dismiss()` / `reset()` / `getView()`。
- **`builtins.ts`** — 对两个主机提供商注册一次（幂等元），每个主机都被 `source` 设置限制，因此更改会被 live 应用，加上 `buildAutocompleteContext`（存储行 + 输入→上下文）。

### D2 — React 胶水故意稀薄

`hooks/terminal/use-terminal-autocomplete.ts`将控制器连接到设置+终端存储器和LLM工具客户端（`buildUtilityLlmClient`），并注册内置功能。`components/terminal/terminal-ghost-text.tsx`是一个纯粹的表示叠加层（`pointer-events: none`，继承终端字体），位于xterm光标处。`terminal-instance.tsx` `onData`块输入hook，渲染叠加层，在 `attachCustomKeyEventHandler` 中截取 **Tab / → 接受** 和 **Esc 关闭**（没有提示时会掉落，这样 Tab 键仍然到达 shell，→ 光标仍然移动），并在 633 `prompt_start` / `command_start` 上重置线模型OSC。

接受会让后缀直接写入`session.write`——*不是*写到`onData`——所以没有重复送入，也不会让用户按回车。

### D3 — 隐私 + 许可严格

- AI源是**选择加入**（`terminal.autocomplete.enabled`默认关闭），`source`为`history | ai | both`（默认`both`）。仅历史记录是完全离线的。
- 在任何模型调用之前，汇编的上下文（部分命令 + cwd + 近期历史）都会通过共享的`hasNoLeakingPii` 门禁;检测到的 API 密钥/令牌/凭证/电子邮件/卡片会无声跳过请求——终端上下文不会泄露到模型。
- 当没有配置模型时`buildUtilityLlmClient`返回空，且AI 提供商降级到零（历史记录仍然有效）。
- 接受只填充了一行;用户仍然按回车。没有自动执行。

### D4 — 脚本型跑者（`lib/terminal/script-runner.ts`）

`detectScriptType(path, { shebang, platform })`将文件映射到`{ kind, interpreter, interpreterArgs }`：一个`#!` shebang（解析后，包含`/usr/bin/env prog`）获胜，否则扩展名（`.sh`→bash、`.ps1`→`pwsh -NoLogo -File`、`.py`→`python3`/`python`、`.js`→node、`.ts`→tsx、`.rb`/`.pl`/`.php`/`.lua`/`.nu`/`.R`、`.bat`/`.cmd`→`cmd /c`）。`buildScriptSpawnRequest`把它变成了扩展坞可以生成的`SpawnRequest`。新的渲染侧 `ShellKind` + `detectShellKind` 镜像Rust `ShellKind::from_shell_path`，这样两边的 shell 感知特性都能一致。

### D5 — 全插件曝光

- **`ctx.terminal`**（`lib/plugin/api/terminal-api.ts`）获得`registerCompletionProvider`（门控`terminal:completion`）、`runScript` + `detectScriptType`（门控`terminal:spawn`），重复使用相同的所有权检查码头原语。
- **新权限`terminal:completion`** — 无危险（它会提交建议并读取正在进行的输入行;敏感但不破坏，像`git:read`）。添加到联合中，`PERMISSION_GROUPS`、`PERMISSION_DESCRIPTIONS`、`validation.ts`的`VALID_PERMISSIONS`和Rust `cognia plugin lint`白名单。
- **Manifest `terminalCompletionProviders`**——懒惰的 `{ id, label, entry, export, priority }` 工厂，由 `lib/plugin/bridge/terminal-completion-bridge.ts`（以 `ai-providers-bridge` 为模型）解决，并接入 `MODULE_BRIDGE_CAPABILITIES` 调度，使其在 enable/disable 时真正触发。桥接器的适配器 + `registerPluginCompletionProvider` 同时返回声明式和命令式（`ctx.terminal.registerCompletionProvider`）路径，因此插件提供商在拆除时一起清理。

### D6 — Settings + i18n

`AppSettings.terminal.autocomplete`（`{ enabled, source, debounceMs }`）在终端设置卡中驱动“AI 命令自动补全”组（切换 + 源选择 + 去跳出 + 隐私说明具体发送给型号的内容）。新的 i18n 密钥既能出现在`en.json`，也包含在`zh-CN.json`（`terminal.ghost.acceptHint`、`settings.terminal.autocomplete.*`）;`pnpm lint:i18n` 确认对等性。

## 测试覆盖范围

每个文件的共址测试（CLAUDE.md规则#3，≥新代码的90%）：

- 发动机：`line-buffer`（29）、`prompt`（18）、`registry`（12）、`history-provider`（6）、`ai-provider`（8）、`controller`（10）、`builtins`（4）。
- 剧本：`script-runner`（24）+ `shell-detect`（`detectShellKind`）。
- 插件：`terminal-api`（扩展 — runScript/detectScriptType/registerCompletionProvider）、`terminal-completion-bridge`（12）、`module-bridge-map`（计数锁11→12）、`permission-guard` / `validation`（终端：完成）。
- React：`terminal-ghost-text`（4）、`use-terminal-autocomplete`（4）、`terminal-instance`（扩展——7个自动补全积分测试）、`terminal-card`（扩展——3个自动补全测试）。

全部为绿色;`pnpm lint:i18n`为绿色。树中唯一的`tsc`错误是存在于无关并发工作的（`perf-api`/`connectors-api`）。

## 文件摘要

**Net-new**：`lib/terminal/completion/{types,line-buffer,prompt,registry,history-provider,ai-provider,controller,builtins}.ts`（+tests）、`lib/terminal/script-runner.ts`（+test）、`hooks/terminal/use-terminal-autocomplete.ts`（+test）、`components/terminal/terminal-ghost-text.tsx`（+test）、`lib/plugin/bridge/terminal-completion-bridge.ts`（+test）、`types/plugin/plugin-terminal-completion.ts`，这个ADR（en + zh）。

**扩展**：`lib/terminal/shell-detect.ts`（+`ShellKind`/`detectShellKind`）、`components/terminal/terminal-instance.tsx`、`components/settings/terminal/terminal-card.tsx`、`lib/plugin/api/terminal-api.ts`、`lib/plugin/contracts/module-bridge-map.ts`、`lib/plugin/core/validation.ts`、`lib/plugin/security/permission-guard.ts`、`types/plugin/plugin.ts`、`lib/claude/types.ts`、`crates/cognia-cli/src/cmd_lint.rs`，都是i18n消息文件。

## 修订（2026-08-28）—— 聊天输入框的 `!` 行

聊天输入框（`components/chat/composer.tsx`）的 `!` 模式本身就是一个 shell
提示符，却没有以上任何能力：一个 `textarea`、一行回显、以及 `shell_exec`。本次
修订为它补上补全、校验，以及"这行到底能不能跑"的诚实回答——复用 Phase 4 引擎的
**数据**，只替换其中假设存在 PTY 的部分。

### D7 —— 统一的智能层 `lib/shell-intelligence/`

输入框不是终端：没有 PTY、没有 OSC 633 事件流、没有行缓冲，它的"一行"只是
`textarea` 的一段切片，而这个 `textarea` 同时还装着 `/命令` 与 `@提及`。因此
Phase 4 的 `controller` / `line-buffer` 不适用；适用的是它们下面的一切——
`shell-builtins`、`spec/` 命令集、`terminal_complete_paths`、
`terminal_list_path_executables`——这些被原样复用。

新增的是 Phase 4 从未需要的东西：**位置**。ghost-text 的各个 provider 都假设首词
就是 token 0——在提示符下成立，一旦行里出现管道就不成立。`lex.ts` + `segments.ts`
增加了一个感知操作符的词法器（`|`、`&&`、`||`、`;`、`&`、带文件描述符前缀的重定向、
`$(…)`、反引号、子 shell、环境变量赋值）和一个分段器，只回答一个问题：*光标下的
token 是什么，它在自己那条命令里扮演什么角色？* 于是 `cat foo | gre` 补出 `grep`，
而不是给 `cat` 补一个文件。

刻意不做完整 shell 文法：没有语法树、没有展开、没有求值。无法分类的一律降级为普通
词——代价是少一条建议，而不是一次错误的执行。

### D8 —— 主机就是能力边界，而且要说出来，不是藏起来

三种状态，因为把它们混作一谈正是"功能看起来坏了"的成因：

| 状态 | 补全 | 执行 |
| --- | --- | --- |
| `full` —— 主机可达 | 内建命令、CLI 规格、`$PATH`、文件系统 | 可以 |
| `static-only` —— 没有主机 | 内建命令、CLI 规格 | 不可以，并说明原因 |
| `shell-unavailable` —— 有主机但没有该 shell | 除执行外全部可用 | 不可以 |

独立浏览器仍然保有 `git`/`kubectl`/参数补全（它们是静态数据），并被告知去连接主机，
而不是看到一个空面板。`terminal_list_path_executables` 从本机 Tauri 命令提升为
companion RPC（`READ_ONLY` + 受控能力门，与 `terminal_complete_paths` 完全一致——
它报告的是主机已安装的可执行文件，而只有已经能**运行**它们的客户端才用得上）。

### D9 —— shell 归用户所有，其 argv 只有一处知道

优先级：`terminal.defaultShell` → 主机上报的默认值 → 平台猜测。配置了主机上不存在
的 shell 时呈现为 `shell-unavailable` 并禁用执行，而不是悄悄换一个 shell 去跑。

`shell-argv.ts` 是唯一知道"如何把一行交给 shell"的地方——sh/bash/zsh 用 `-lc`，
fish 用 `-l -c`（它不接受合并写法），nu 用 `--login -c`，两个 PowerShell 用
`-NoLogo -Command`，cmd 用 `/D /S /C`——未知家族一律报告 `unsupported`，绝不瞎猜。

这也是执行从 `shell_exec`（仅桌面、硬编码 `sh -c` / `cmd /C`）迁到经传输层路由的
`terminal_exec` 的原因：只有这样 `terminal.defaultShell` 才有意义，也只有这样配对的
浏览器或手机才跑得动一条 `!` 行。`shell_exec` 的 64 KB 输出上限与 30 秒默认超时在
`execute.ts` 中重新施加，因为 `terminal_exec` 两者都没有。

### D10 —— 诊断只是提示，难点在时机

`command-not-found`、`incomplete-syntax`、`shell-unavailable` 会画下划线；三者都不
拦截 Enter。用户的 shell 才是权威，一个会拦截执行的下划线，只会让"检查器判断错了的
那条命令"变得无法运行。

检测很容易，**时机**才是设计。通往 `kubectl` 路上的 `k` 不是错误。一条命令只有在被
**确认结束**后才被判定——由空白、操作符或 Enter 确认；否则需要输入静止 200 ms 且长度
至少两个字符。主机查询尚未返回的名字是 `pending` 而非 `unknown`：一次未完成的探测
不该让每条命令在等待期间都挂上下划线。

### D11 —— 刻意不读运行中的 PTY 状态

V1 共享所选主机、有效工作目录、配置的 shell 以及主机的 `$PATH`；不读取已在运行的
PTY 内部的别名、函数、导出变量或 `cd`——这里根本没有 PTY 可读。因此只以别名形式存在
的命令会被判为未知；这是边界带来的诚实代价，也正是诊断只做提示而非闸门的理由。

同样不在 V1 范围内（与 Phase 4 的非目标一致）：CodeMirror、tree-sitter、动态
zsh/fish 补全 sidecar、下载第三方补全规格，以及本界面上的 AI 补全。

### 输入框侧的实现要点

`textarea` 仍是唯一的输入状态。上/下移动高亮，Tab 接受，Escape 关闭，Enter 照旧执行
——且这些都不会在 IME 组字期间触发。候选项复用既有 `ComposerPopover` 的条目模型（新增
一种 `shell` 类型），因此键盘导航、滚动定位与选取路径与其他所有选择器完全一致。诊断由
第三层浮层绘制，与 chip、ghost 两层共享 `TEXTAREA_TYPOGRAPHY` + `padEndClass` + 滚动
镜像契约，并配一个 `role="status"` 的礼貌播报区承载同样的文案供辅助技术读取。

`terminal.autocomplete.enabled` 是两个界面共同的总开关：关闭时，`!` 模式与本次修订之前
完全一致。

**影响范围（本次修订）**：`lib/shell-intelligence/*`、`hooks/chat/use-shell-intelligence.ts`、
`components/chat/composer/{shell-completion-row,shell-diagnostic-overlay,composer-box}.tsx`、
`components/chat/{composer,composer-popover}.tsx`、`lib/terminal/remote-api.ts`、
`lib/terminal/completion/path-provider.ts`、`src-tauri/src/companion_api/rpc{,/terminal}.rs`、
`protocol/companion-{commands,request-schemas,response-schemas}.json`、
`protocol/headless-command-dispositions.json`、`i18n/messages/{en,zh-CN}/chat.json`。

## 明确规划的后续

1. **幽灵文本像素对齐**——`cursorPixelPosition`读取xterm（内部）渲染服务单元的尺寸;在DOM渲染器或首次绘画之前返回空值，叠加层根本不显示。采用public-API测量路径会加重这一问题。
2. **内联错误解释/修复**——ADR-0033 #4的另一半（解释失败的命令，建议修复）是自然的下一个提供商，但这里没有构建。
3. **移动自动补全**——WS 传输今天不提供OSC 633（ADR-0031#2），屏幕键盘使幽灵文本的实用性降低;被推迟。
4. **更多脚本类型/shell**——elvish、tcsh、xonsh等各是一个映射条目（对于OSC 633来说，是一个Rust壳集成脚本）。
