---
title: "0210 — 插件可以携带 Pi 包"
description: "Cognia 插件通过 `piPackages` 贡献（能力 `pi-package`）携带完整 Pi 编码代理包。依赖准备步骤经用户确认，不经过 shell。通过 `pi install <绝对路径>` 安装到用户 Pi，不可用时编辑 settings。仅为显式引用该包的 `pi-rpc` 代理，通过 `-e` 在托管会话加载扩展。配置经环境策略放行的 `COGNIA_PIPKG_` 前缀传递，其他程序不读取。转换器原样保留外来 Pi 包，各厂商格式按 2026-10-02 文档更新。"
---

# ADR 0210 — 插件可以携带 Pi 包

**状态：** 已采纳**日期：** 2026-10-02 **相关：** [ADR-0119](./0119-pi-native-rpc-integration)（Pi 原生 RPC、扩展隔离、代理包）、[ADR-0051](./0051-external-agent-adapter-plugin-type)（外部代理插件类型）、[ADR-0155](./0155-plugins-reach-the-host-through-one-door)（插件 SDK 边界）、[ADR-0156](./0156-every-in-tree-plugin-is-a-third-party-plugin)（树内插件）、[ADR-0209](./0209-a-cogpack-pins-plugins-and-a-cogset-owns-what-runs)（安装来源）

## 背景

Pi LaTeX Workbench（`github.com/Arxtect/pi-latex-workbench`）本身是一个 Pi 包：`package.json` 的 `pi.extensions` 指向一个 TypeScript 扩展，注册八个受控的 `latex_*` 工具；另有 `latexwb` 宿主 CLI 和资源树（技能、模板、工作流、策略）。把它做成 Cognia 插件时暴露了三个缺口。

- **插件无法把东西交给 Pi。** `lib/pi-packages/` 已经会执行 `pi install|remove|update`（并能退化为编辑 `settings.json`），但只能从“代理包”面板触发，插件无法调用；也没有任何清单字段表达“本插件携带一个 Pi 包”。
- **托管 Pi 会话只加载一个扩展。** ADR-0119 用 `-e` 固定加载 Cognia 自己经过摘要校验的扩展。插件扩展进不了托管会话；外部代理的环境策略还会丢弃白名单之外的所有变量，因此依赖环境变量配置的包（Workbench 通过 `LATEXWB_*` 绑定项目）无法被配置。
- **转换器把 Pi 当作只有技能。** `pi.extensions`、`pi.prompts`、`pi.themes`、`dependencies`、`scripts` 都会阻断，真实的 Pi 包总是转换失败，导出也只写 `pi.skills`。另外几个厂商适配器已经偏离其公开契约（Kimi 的清单其实是根目录 `plugin.json` 加 `tools[]`；Agent Plugins 有 1.1.0 草案和客户端命名空间目录；Codex 读取四种清单位置并把命令迁移为技能；Cursor 新增了 rules、agents、commands、hooks 与 variables），还缺少五种有真实清单的格式。

## 决策

### 1. `piPackages` 是一种插件贡献

`types/plugin/plugin-pi-package.ts` 定义 `PluginPiPackageDef`，声明在 `manifest.piPackages` 下，能力为 `pi-package`。条目包含插件内的相对包目录、可选的 `minPiVersion`、可选的 `prepare` 步骤和可选的 `hostedSession` 块。该目录是完整的 Pi 包，Cognia 不改写它，Pi 加载的就是作者交付的内容。

`builtin://` 插件没有 Pi 能读取的目录，因此内置插件不能使用该能力。

### 2. 依赖准备是经确认的固定步骤

Pi 从不为本地包安装依赖。`prepare` 声明一次包管理器调用（`npm` 或 `pnpm`、静态参数、插件内相对的标记文件、受限超时）。它不经过 shell 执行，执行前弹出显示确切参数的确认；声明了 `prepare` 时，安装到 Pi 之前必须已经执行过。宿主包（`@earendil-works/pi-*`、`typebox`）不能进入包自己的 `node_modules`（Pi 会映射到自身的副本），所以 Workbench 的步骤使用 `--omit=dev --omit=peer --ignore-scripts`。插件运行时拒绝加载含有符号链接的插件目录树，因此宿主会为 `npm` 步骤追加 `--no-bin-links`（显示在确认提示中），运行后检查包目录中是否有链接（`symlinks-created`），校验器也会提示 `pnpm` 默认会创建链接。安装时由目录中路径字段的 `kind` 决定哪些内容必须已存在：`path` 必须是已存在的目录（`.` 表示插件根目录），每个托管扩展必须是已存在的文件，标记文件只做词法包含检查——它在 `prepare` 之后才出现。

### 3. 安装到 Pi 复用 Pi 包管理器

安装和移除委托给 `lib/pi-packages/host.ts` 的 `runPiMutation`，以包的绝对目录为 spec，支持用户级或项目级范围。Pi 不可用时退化为编辑 `settings.json`，界面会如实说明，与“代理包”面板一致。安装状态通过 `loadPiPackages` 和 `piPackageIdentity` 读回，因此从 Cognia 安装和手动 `pi install` 的是同一个条目。

### 4. 托管会话只为显式选用的代理加载包

带 `hostedSession` 的包可以按 `pi-rpc` 代理逐个选用（代理元数据 `piPackages: ["<pluginId>/<packageId>"]`）。加载按代理生效、从不全局生效，因为扩展可能接管整个会话：Workbench 会把活动工具限制为自己的八个并拦截其他调用（选用前会显示 `controlsSession: true`）。

会话启动时适配器解析每个引用——缺失、禁用或未准备的包会以带类型的错误终止启动，而不是被跳过——并在 Cognia 自己的扩展之前为每个声明的扩展追加一个 `-e <绝对路径>`；Cognia 扩展照常加载并拦截每次工具调用。声明的 `tools` 只在会话本就预先批准它们时（`dontAsk`）通过 `--tools` 下限，每次调用仍由权限表的扩展回退决策裁定。每个插件扩展让握手时限增加 15 秒，总体不超过现有的 120 秒上限。

沙箱只为 `pi` 命令以只读方式挂载每个已解析的包目录。适配器给出的 `COGNIA_TOOLHOST_PI_PACKAGE_ROOTS` 列表只是请求，不构成授权：该变量走的是已审查的 `COGNIA_TOOLHOST_` 前缀，任何能设置启动环境变量的一方都能在其中写入路径。因此远程启动策略（`SpawnPolicy::validate`）直接丢弃它——远程调用方永远不能指定沙箱根；桌面包装器只保留规范化（解析符号链接）后为已存在目录、且严格位于宿主根据自身数据目录推导出的插件安装根（`<data dir>/cognia/plugins`）之下的条目，绝不采用渲染进程的输入。以下条目也会被丢弃并记录原因：该根之下的部分命中受保护路径；本身是或包含禁止读取的根（含 `/private/var`、`/private/tmp` 等所有写法）；或位于包装器发出的任一 `--deny-readable` 根之下——启动器会重新开放嵌套在拒绝根下的可读路径，因此 Bot 隔离的主目录、网关任务的拒绝列表及任务主目录的上级都保持关闭。所以 Bot 隔离的代理无法加载插件包，适配器会以 `bot-isolation` 拒绝启动，而不是让 Pi 找不到文件。代理自身环境变量中填写的该值会被丢弃，只有已解析的包才会设置它。Pi 按规范路径对扩展去重，因此位于包目录内的扩展即使该包也已安装到会话读取的范围里，也只加载一次。位于包目录外的包装扩展无法去重：当会话的扩展策略也会加载已安装副本时，启动会以 `double-load` 被拒绝，并提示用户把代理改为隔离模式或从对应 Pi 范围移除该包，而不是悄悄丢掉包装层的配置。

### 5. 配置通过 `COGNIA_PIPKG_` 传给扩展

`hostedSession.env` 把名称绑定到插件配置键、清单字面量或会话工作区，以 `COGNIA_PIPKG_<NAME>` 转发；`COGNIA_PIPKG_` 被加入外部代理的环境前缀白名单（Rust `presets.rs` 与 CLI 的 Node 后端）。放行这个前缀是安全的：除了专门配合的扩展，没有程序读取它；插件仍然无法设置 `NODE_OPTIONS`、`LD_PRELOAD`、提供商凭据或任何其他变量，值也从不来自模型。策略还会从命令不是 Pi 的启动中丢弃所有 `COGNIA_PIPKG_*` 键。这一保证只在启动时成立：Pi 运行后，扩展代码（包括插件自己的）可以为它自己派生的进程设置任意变量；该前缀限制的是 Cognia 交给进程的内容，而不是进程内代码的行为。Workbench 的胶水扩展仅在 `LATEXWB_*` 未设置时把 `COGNIA_PIPKG_LATEXWB_*` 映射过去，然后原样加载 vendor 的扩展。

### 6. 转换器完整保留 Pi 包

导入 Pi 包时，技能和提示模板转换为 Cognia 技能，整个包按字节原样、原地（`path: "."`）保留为一个 `piPackages` 条目，因此交还给 Pi 时完全一致。之所以原地保留，是因为 GitHub 与本地加载安装器只允许向源码树添加 `plugin.json` 和 `dist/index.js`。扩展不会被翻译成 Cognia 工具：它们只在 Pi 中运行，只有作者声明并审阅过 `hostedSession` 后才会被托管加载。导出到 Pi 时，唯一的 `piPackages` 条目成为包根目录，导出的技能合并进 `pi.skills`。

厂商适配器按 2026-10-02 获取的文档（记录在 `docs/research/`）更新，并新增 Factory Droid、Qoder、CodeBuddy、Auggie 与 Open Plugins（`.plugin/plugin.json`）布局。Qwen Code、Kiro Powers 以及纯代码插件体系（Amp、Cline、Zed）不在范围内。

### 7. Workbench 插件原样 vendor 上游

`plugins/pi-latex-workbench/` 在 `vendor/` 下保存上游指定提交的源码（不含测试、fixtures、录制结果和已下载的工具链），由同步脚本校验，并从 Cognia 的 TypeScript、Jest、ESLint 与作者导入检查中排除。Cognia 代理通过 `cliTools` 使用宿主 CLI，`cliTools` 的 argv 字面量现在会展开 `${COGNIA_PLUGIN_ROOT}`；没有任何工具暴露审批或授权入口，因为 Workbench 的信任边界是模型永远不能批准自己的工作，审批始终由操作者在 Pi 会话或宿主 CLI 中完成。

## 后果

- 任何插件都可以携带 Pi 包，Workbench 是第一个。
- 从 Cognia 执行 `pi install` 与手动执行会收敛到同一个 settings 条目。
- 选用该包的托管 Pi 代理会成为受控工作者；未选用的代理不受影响。
- 上游 Workbench 没有 LICENSE 文件，在本仓库之外发布该插件前必须与所有者确认分发条款。
- 渲染仍仅支持 macOS arm64；约 2.9 GB 的 tectonic 工具包是用户执行的宿主准备步骤，而不是工具调用（超过 `cliTools` 的 600 秒上限）。
