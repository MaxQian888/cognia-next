---
title: "0196 — 库 crate 只在被要求时才链接 Tauri"
description: "ADR-0067 把 Tauri crate `app_lib` 从 17 万行削到 6.7 万行，却没有任何东西阻止它回涨：十周后它回到 18.7 万行，`companion_api` 一个模块就有 9.6 万行，十九个库 crate 链接了 `tauri`，headless 的 `cognia-server` 镜像里装着 webkit。本 ADR 为 Rust workspace 定义一张由门禁强制执行的分层图；让每个库 crate 默认不链接 Tauri，把命令外壳放到只有应用会开启的 `tauri-host` feature 之后；把 `companion_api` 拆成一组位于宿主 trait 之后的 companion crate；最终让 `cognia-server` 成为完全不链接 Tauri 的独立包。"
---

# ADR 0196 — 库 crate 只在被要求时才链接 Tauri

**状态：** 已接受 — 实施中（P0–P5 与 P7 已落地，P6 部分落地；见下文"进展"）
**日期：** 2026-09-25
**相关：** [ADR-0067](./0067-src-tauri-crate-decomposition-and-build-speed)（第一次拆分；本 ADR 是它的延续）、[ADR-0014](./0014-capacitor-mobile-shell)（headless 服务端）、[ADR-0021](./0021-webrtc-datachannel-wan-transport)（`companion_api` 持有的 WebRTC 传输）、[ADR-0059](./0059-cloud-deployment-headless-brain)（`cognia-server` 镜像）

## 背景

ADR-0067 在 7 月把单体 `app_lib` 拆成了二十个库 crate。到 9 月底，数字已经反转：

| 指标 | ADR-0067 Tier B 之后 | 2026-09-25 |
| --- | --- | --- |
| `src-tauri/src` 行数 | 6.67 万 | 18.68 万 |
| `companion_api` 行数 | 2.82 万 | 9.65 万（112 个文件） |
| 默认链接 `tauri` 的库 crate | — | 19 |
| `Cargo.lock` 包数 / 多版本包名 | 1,331 / 130 | 1,545 / 164 |

仓库里没有任何机制让拆分保持住。贡献者文档仍然让人把命令加到 `src-tauri/src`；clippy 排除了 `cognia-next`，所以 `app_lib` 从未被 lint；同位测试门禁不看 `crates/`；也没有任何检查约束哪个 crate 可以依赖哪个。分层于是在无声中退化：

- 基础层 crate `cognia-net` 吸收了 `rquickjs`（C 语言 JavaScript 引擎）和 `cognia-secrets`，连带影响它之上的每一个 crate；
- 文档声称不依赖 Tauri 的 `cognia-agent-state`，通过 `cognia-gateway` 的默认 feature 链接到了 `tauri`；
- `cognia-observability` 为了一次截图调用链接了 4.5 万行的 `cognia-automation`；
- `cognia-terminal` 和 `cognia-plugin-runtime` 链接 `cognia-automation` 只是为了它的执行沙箱模块。

由于十九个库 crate 无条件链接 `tauri`，headless 的 `cognia-server`——它是 `src-tauri` 的一个 `[[bin]]`，链接整个 `app_lib`——无法在没有 Tauri 的情况下构建，它的 Docker 镜像要安装并携带 webkit2gtk。两个只用标准库的安装程序二进制也要重新编译整个 `app_lib`。

`lib.rs` 的装配也变得脆弱：1,117 个命令、47 个托管状态、554 行的 setup 钩子、11 个未调用时行为各不相同的进程级全局 setter。它还调用了两次 `Builder::setup`。Tauri 只保留最后一个闭包（`self.setup = Box::new(setup)`），所以第一个闭包——推送凭据、fs 允许目录初始化、备份目录的 fs scope、任务工作区维护、gateway brain bridge、WASM 插件宿主服务——在桌面端从未运行过。

## 决策

### 1. workspace 有分层，由门禁强制执行

`scripts/gates/rust-architecture.json` 为每个 workspace 成员分配一个层：

```
foundation  problem · canonical-json · instrument · core · git-mirror · headless-contract
            secrets · net · tenant-auth · deployment · (companion-contract)
platform    jobs · environment · agents · files · media · sandboxd
            (exec-sandbox · provider-diagnostics · sidecar · hooks
             companion-security · companion-connectivity · companion-bus)
domain      git · ocr · vector · automation · scheduling · terminal · subscription · connectors
            plugin-runtime · skills · tts · gateway · ccswitch · mcp-server · external-agent
            task-workspace · observability · agent-state · sandbox-pool
            (codex-app · fleet · browser-cookies · codeserver)
companion   (companion · companion-rpc)
service     cli · collab-server · ops-controller · deploy-agent · sandbox-runner
            (cognia-server · elevated-setup)
app         cognia-next (src-tauri)
```

括号中的 crate 由下文各阶段规划。

`pnpm audit:rust-architecture` 读取 `cargo metadata --no-deps` 并检查：

1. 每个成员都有层；
2. 每条内部依赖边都指向更低的层，或是按名称列出的同层边；
3. 禁止触达——基础层 crate 的默认 feature 闭包中永远不含 `tauri`、`wry`、`rquickjs`、`wasmtime`、`matrix-sdk`、`uiautomation` 或 `webrtc`，`cognia-sandboxd` 永远不触达网络栈；
4. 在默认 feature 下，没有库 crate 触达 `tauri` 或任何 `tauri-plugin-*`；
5. 只有 `cognia-next` 能开启其他 crate 的 `tauri-host` feature；
6. `src-tauri/src` 只允许有允许列表中的顶层模块，行数保持在每次拆分都会下调的上限之下。

门禁自己逐 crate 解析 feature，只沿 workspace 内部边遍历。`resolve` 会在整个 workspace 范围统一 feature，因为应用开启了 Tauri，于是每个 crate 看起来都会触达 Tauri。`:deep` 用 `cargo tree -p <crate> -i tauri` 交叉验证每个结论。门禁落地时已存在的违规记录在 `rust-architecture-baseline.json` 中，该列表只能缩小。

### 2. 库 crate 只在被要求时才链接 Tauri

每个库 crate 在默认 feature 下都不依赖 Tauri。它的 `#[tauri::command]` 外壳和 `AppHandle` 适配器放在 `tauri-host` feature 之后（`default = []`，`tauri-host = ["dep:tauri", …]`）。只有 `src-tauri` 会开启它。这沿用了 `cognia-observability` 的 `desktop-host`，它早已这样工作。

- 命令放在子模块中（`#[cfg(feature = "tauri-host")] pub mod commands;`）——crate 根上的 `#[tauri::command]` 会在宏命名空间冲突（E0255）。
- crate 内的适配器（`AppHandleEmitter`、`AppHandleTaskDueEmitter`、`TauriWasmHostServices`……）移入该 crate 的 `tauri_host` 模块，并在 feature 之后按原路径重新导出。
- 非命令代码通过 `cognia_core::rt::spawn` 派生任务，而不是 `tauri::async_runtime::spawn`。
- CI 会在开启所有 crate 的 `tauri-host` 后再跑一遍 workspace 测试和 clippy，命令代码因此不会从 CI 中消失。

### 3. 新的 Rust 逻辑进 crate

新的 Rust 逻辑放进 `crates/` 下能承载它的最低层 crate。`src-tauri/src` 只负责装配桌面应用：`lib.rs`、`startup/` 启动步骤、窗口/托盘/浮层/webview 代码、`AppHandle` 适配器。在那里新增顶层模块会让门禁失败并指向本 ADR。

拆分沿用 ADR-0067 的 shim + 重新别名技术：`pub use cognia_x as x;`（或门面模块）让每个 `crate::x::…` 路径和每个 `generate_handler!` 条目继续编译——包括其他会话尚未提交的代码。

### 4. `companion_api` 拆成位于宿主 trait 之后的 companion crate

`companion_api` 拆成六个 crate：

- `companion-contract`——生成的命令清单；
- `companion-security`——安全存储、身份、授权、JWT 与 OIDC、`DeviceContext`；
- `companion-connectivity`——TLS、mDNS、mesh、隧道和 WebRTC peer（隔离 `webrtc`）；
- `companion-bus`——事件平面、推送、数据桥；
- `companion`——核心：鉴权 HTTP、`remote_execution`、RPC 门禁、服务器和 WebSocket 传输；
- `companion-rpc`——十六个 RPC 族。

让核心离开应用的接缝：

- `CompanionState.app_handle` 变为 `renderer: Option<Arc<dyn RendererPort>>`（emit、桥接传输、资源目录）；
- RPC 门禁和 `dispatch_canonical` 移入不依赖 Tauri 的 `rpc_core`，各 RPC 族通过安装的 `CommandDispatcher` 接入——这也打破了 `rpc ↔ remote_execution` 的循环；
- 封闭的 `DispatchHost { Tauri(AppHandle), Headless(..) }` 枚举变为对象安全的 `RpcHost` trait，用类型化访问器取代 `host.tauri_app(name)?.state::<T>()`；
- `HeadlessHooks`、`RouteContributor` 和 `WorkerRosterObserver` 取代核心对 `crate::headless::headless_services()`、`fleet` 和 `codeserver` 的直接读取。

在整个计划期间，`companion_api` 作为门面模块留在 `app_lib` 中。

### 5. 进程级全局槽位只有一种行为

`cognia_core::installed::{Installed<T>, Replaceable<T>}` 取代各自为政的 setter。重复安装时按槽位名告警；未安装时返回带名称的 `NotInstalled` 错误；每个二进制在启动结束时检查所有必需槽位都已填好。

### 6. `cognia-server` 成为独立包

headless 服务端移到 `crates/cognia-server`（lib + bin），不链接 Tauri。CI 门禁断言 `cargo tree -p cognia-server -i tauri`（以及 `wry`、`webkit2gtk`）没有任何匹配；它只用 `-p` 运行，因为 `--workspace` 构建会统一开启 `tauri-host`。Docker 镜像去掉 webkit、gtk、soup、ayatana 和 rsvg，桌面端的 terminal-host sidecar 也随之变小。

## 阶段

每一步都是一个提交，除 P0a 外都不改变行为。每一步都要通过：该 crate 在开启与不开启 `tauri-host` 时的测试、`cargo check -p cognia-next`、`pnpm audit:rust-architecture`，以及按路径识别 companion 文件的门禁。

| 阶段 | 内容 |
| --- | --- |
| P0 | 修复重复的 `setup`（六个宿主服务在桌面端重新运行）；把 setup 拆成有序的 `startup/` 步骤；删除死掉的 shim |
| P1 | 本门禁；覆盖 crate 的同位测试门禁；`[workspace.package]` / `[workspace.dependencies]` / `[workspace.lints]`；统一 `rust-version` 和自有依赖版本；覆盖 `cognia-next` 的 clippy；文档 |
| P2 | 分层修复：`cognia-provider-diagnostics` 从 `cognia-net` 拆出；`cognia-exec-sandbox` 从 `cognia-automation` 拆出；observability 的截图提供者与 `tracing-host` feature；`http_client` 移入 `cognia-net`；`cognia-files` 不再依赖 `cognia-agents` |
| P3 | `tauri-host` 改造，headless 路径上的 crate 优先（external-agent、gateway、ocr、mcp-server、scheduling、connectors、terminal、plugin-runtime），automation 最后 |
| P4 | companion 叶子 crate：connectivity、bus、contract、security |
| P5 | 就地反转 companion 核心：`RendererPort`、`CommandDispatcher`、`RpcHost`、运行时钩子、拆分 `commands.rs` |
| P6 | 拆出 `app_lib` 的其余子系统：sidecar、codex-app、hooks、fleet、terminal host bridge 与 SFTP、浏览器 cookie、codeserver、安装程序二进制 |
| P7 | 把 companion 核心移入 `cognia-companion` |
| P8 | 把 RPC 族移入 `cognia-companion-rpc` |
| P9 | `cognia-server` 成为独立的无 Tauri 包；镜像去掉 webkit |
| P10 | 收拢门面、下调行数上限，并在此记录前后对比数据 |

### 进展（2026-09-27）

`src-tauri/src` 从 18.7 万行降到 9.6 万行，`scripts/gates/rust-architecture.json` 中的行数上限随每次抽取同步下调。

| 阶段 | 已落地 | 未完成 |
| --- | --- | --- |
| P0–P3 | 全部：修复并拆分 setup、工作区治理与门禁、分层修正、每个库 crate 的 `tauri-host`，以及 observability 不依赖 Tauri 的 `tracing-host`（trace context 传播） | `desktop-host` 中其余供 `cognia-server` 使用的日志部分（P9） |
| P4 | `cognia-companion-connectivity`、`-bus`、`-contract`、`-security` | — |
| P5 | `RendererPort`；`CompanionRuntime`（分发与应用的路由）及 headless 槽位；`RpcError`、payload 能力门禁与审批权限检查移入核心；`cognia-power` 与 Wake-on-LAN 移出应用 | `RpcHost`（P5.3，随 P8）、拆分 `commands.rs` |
| P6 | `cognia-codex-app`、`cognia-browser-cookies`、`cognia-hooks`、`cognia-fleet`、`cognia-task-workspace-host`、`cognia-terminal::host_client` 与 `::host_bridge`，GitHub 工作区与仓库导入并入 `cognia-git` | sidecar 定位器、codeserver、安装辅助二进制、`jobs` |
| P7 | `cognia-companion`：核心（51 个文件、4.4 万行）；`companion_api` 成为门面，外加分发表、命令外壳与 `wiring` | — |

计划与代码相遇之处：

- **`cognia-task-workspace-host` 是独立 crate，而不是 `cognia-task-workspace` 的模块。** 后者刻意保持同步（不引入 tokio），而宿主层的每个函数体都跑在异步运行时上。
- **终端桥分两步迁出。** `cognia-terminal::commands` 仍保留持久终端宿主出现之前的同名 `terminal_*` 命令（未注册），而 `#[tauri::command]` 会导出 crate 级的全局 `__cmd__*` 宏，因此在删除旧命令之前，桥无法并入该 crate。旧命令删除后，桥命令及其状态位于 `tauri-host` 之后的 `cognia_terminal::host_bridge`；`src-tauri/src/terminal_host_bridge.rs` 改为 glob 重导出（这种写法会带上那些宏），`lib.rs` 中的 `generate_handler!` 无需改动。只有 `terminal_host_service` 的命令外壳留在应用中：它的 LAN URL 兜底要读取 companion 服务端的状态，因此由外壳以闭包形式传给 crate 中的 `run_terminal_host_service`。
- **hooks 运行时与 Fleet 通过槽位接触宿主二进制**（`cognia_hooks::host::HOST`、`cognia_fleet::companion::COMPANION`）：桌面端在启动时填充，`cognia-server` 在安装 headless 服务时填充。Fleet 的两处安装由源码测试固定。
- **当桌面端自身的测试依赖某个 crate 的 `cfg(test)` 行为分叉时，改为 `test-support` 分叉**（Fleet 的恢复文件与 `git` 采集）。`src-tauri` 只在 dev-dependencies 中开启 `test-support`，发布构建不会带上它。
- **核心的应用钩子是字段而非全局量。** `CompanionState.runtime`（`CompanionRuntime`：分发、是否存在宿主、IDE 中继路由）在构造状态时必填，忘记提供的二进制无法编译；若是全局安装，遗漏只会表现为静默的 503 或 404。headless 服务端的附加能力仍是进程级槽位（`runtime::HEADLESS`、`BRAIN`），因为其背后的服务本身就是进程级的，并且在安装这些服务的同一调用中填充。单元测试状态使用 `runtime::unwired()`。
- **WebView 适配器留在应用中。** `TauriRenderer` 需要 bus 的 WebView 传输，而它位于 bus 的 `tauri-host` 之后；crate 不得开启其他 crate 的宿主 feature，且只有应用代码需要取回 `AppHandle`，因此它是 `src-tauri` 中的 `companion_api::host`。
- **核心中所有 `cfg(test)` 分叉都改为 `test-support` 分叉**，理由与 Fleet 相同：应用的测试一直以 `cfg(test)` 编译核心（bridge 的 hello 超时、bridge 槽位归属）。有两个测试在旧 crate 中只是靠测试顺序通过（OIDC 中间件测试依赖另一个测试安装的代理策略），现在各自准备所需环境。
- **`cognia-power` 是独立 crate。** 保持唤醒的断言同时被 sidecar、companion worker 和桌面端的屏幕常亮命令持有，因此位于三者之下，而不是按计划放进 connectivity。
- **sidecar 定位器等待 `lib.rs`。** 插件运行时的解析器在该文件中安装，而它一直有其他会话的改动。

## 影响

- 修改应用外壳不再重新编译 companion 平面；修改 companion crate 也不再经由 `app_lib` 的 18.7 万行重新链接。
- 对任何库 crate 执行 `cargo build -p <crate>` 都不会编译 Tauri，crate 测试二进制因此小而可移植（在 Linux CI 上不需要 webkit）。
- headless 镜像不再携带桌面 GUI 栈。
- `app_lib` 无法再悄悄回涨：新的顶层模块或超过上限的行数是门禁失败，而不是几个月后才发现的意外。
- 代价是 manifest 的改动量，以及一段 `companion_api` 作为 crate 门面的过渡期；shim + 重新别名技术保证在此期间所有现有路径都能继续编译。

## 备选方案

- **沿用 ADR-0067 的模式（crate 直接依赖 Tauri）。** 能加快增量编译，但每个 crate 的闭包里都保留着 Tauri，headless 服务端永远甩不掉 webkit。否决。
- **把所有命令外壳搬回 `src-tauri`。** 能让 crate 不依赖 Tauri，但要把 563 个命令搬进本 ADR 正要缩小的应用外壳。`tauri-host` feature 能达到同样的 crate 纯净度，而不必付出这些改动。
- **只建一个 `cognia-companion` crate。** 更简单，但 RPC 族依赖 codeserver、fleet 和 sidecar，而它们又依赖 companion 核心；合成一个 crate 会形成依赖循环，所以核心和 RPC 族是两个 crate。
