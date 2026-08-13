---
title: "0013 — WASM 组件模型插件"
description: "cognia-next 在原有 frontend / python / hybrid 之外新增一种以 Rust 编译的 WebAssembly 插件类型（wasmtime + WASI Preview 2 + WIT），强隔离 + Zed 风格能力声明 + 多版本宿主链接器 + Ed25519 签名分发，支持本地文件、HTTP URL 或 Git 仓库三种安装源。"
---

# ADR 0013 — WASM 组件模型插件

**Status:** Accepted
**Date:** 2026-05-14
**Branch:** `feat/wasm-plugins`

## 当前状态修订（2026-08-13）

`WasmHostServices` 现已提供 AI/workflow bridge、clipboard 与 notification 服务。v0.1 WIT/ABI 继续冻结，不做原地回填。可选 Sigstore 信任仍不在已接受范围内；包签名继续沿用现有 Ed25519 信任路径。

---

## 背景

cognia-next 现有插件类型有三种 —— `frontend`（在渲染进程中用 `eval()`
加载的 TS）、`python`（PyO3 sidecar）、`hybrid`（前两者组合）。两条路径
长期暴露两类问题：

1. **隔离弱**。TS 插件直接共享 webview 堆，可以读取任意 IndexedDB 行 +
   任意 window 全局；Python 插件直接继承 sidecar 的文件系统和网络权限。
   `lib/plugin/security/permission-guard.ts` 是唯一防线，且仅在 API 边界
   做声明式检查 —— 持有 `eval` 权限的插件代码可轻易绕过。
2. **本地能力差**。TS 插件无法稳定访问本地文件 / 进程 / 操作系统密钥环；
   Python 插件可以，但要拖着 500MB+ 的 Python 运行时。

[Zed](https://github.com/zed-industries/zed) 验证了第三种思路是可行的：
基于 [`wasmtime`](https://github.com/bytecodealliance/wasmtime) + WASI
Preview 2 + 类型化 WIT 契约的 **WebAssembly 组件模型插件**。宿主显式声明
每一个允许插件调用的能力，用户在安装时一次性授权，运行时通过
`StoreLimits` 限制内存、`epoch_interruption` 阻止死循环。本 ADR 把该方案
落到 cognia 上，并按 Tauri + Next.js 宿主的约束做了取舍：

- 运行时仅在 Tauri 桌面端可用；web 模式 UI 显示「需要桌面端」提示。
  wasmtime 引擎位于 `src-tauri/`，前端通过 Tauri command 调用。
- 三种安装源（本地文件、HTTP URL 加 Ed25519 签名、Git 仓库 +
  `cargo-component` 构建），v0.1 不引入 Zed 那种 monorepo 注册中心。
- v0.1 只交付一个 WIT 版本（`0.1.0`），但已经把"多版本宿主链接器"的
  脚手架放到位 —— 当 v0.2 出现破坏性变更时，老插件不会失效。

---

## 决策

### 架构总览

```
┌──────── 渲染进程（Next.js webview）─────────────────────────────────┐
│                                                                      │
│  lib/plugin/                                                         │
│   ├─ core/wasm-loader.ts        IPC 客户端（plugin_wasm_*）          │
│   ├─ core/loader.ts             case "wasm" → loadWasmDefinition     │
│   ├─ core/manager.ts            installWasmPluginFromLocalFile，    │
│   │                              卸载时调用 clearWasmCapabilityGrant │
│   ├─ security/wasm-grant.ts     applyWasmCapabilityGrant + preopens  │
│   ├─ security/signature.ts      verifyDetachedBundleSignature        │
│   └─ package/                                                        │
│       ├─ http-installer.ts      installFromUrl + 受信任发布者账本    │
│       └─ git-installer.ts       installFromGit + 工具链提示          │
│                                                                      │
│  components/plugins/                                                 │
│   ├─ wasm-capability-grant-sheet.tsx   一次性授权 UI                 │
│   ├─ use-wasm-capability-grant.tsx     命令式 hook                   │
│   ├─ install-wasm-plugin-button.tsx    本地文件选择入口              │
│   └─ install-from-url-dialog.tsx       HTTP URL + 签名流             │
│                                                                      │
│  lib/db/trusted-publishers.ts  已接受作者公钥的 Dexie 账本           │
└──────────────────────────────────────────────────────────────────────┘
                                │
                                │ Tauri IPC
                                ▼
┌──────── Tauri 宿主（Rust）─────────────────────────────────────────────┐
│                                                                        │
│  src-tauri/wit/cognia-plugin.wit          v0.1.0 契约                  │
│                                                                        │
│  src-tauri/src/plugin_api/wasm/                                        │
│   ├─ mod.rs            HOST_API_VERSION = "0.1.0"                      │
│   ├─ engine.rs         共享 Engine + 100 ms epoch 心跳                  │
│   ├─ store.rs          HostState + StoreLimits + CapabilitySet         │
│   ├─ host.rs           WasmPluginHost + version_linker 路由            │
│   ├─ wit/since_v0_1.rs bindgen! + 各接口的 Host impl                   │
│   ├─ capabilities/     每个接口的能力闸门（capability string）         │
│   ├─ installer.rs      plugin_wasm_install_from_{url,git}              │
│   └─ commands.rs       Tauri command                                   │
│                                                                        │
│  wasmtime 26 · component-model · async · epoch_interruption            │
└────────────────────────────────────────────────────────────────────────┘
```

### 插件类型扩展为四种

```ts
PluginType = "frontend" | "python" | "hybrid" | "wasm"
```

`type: "wasm"` 引入三个新 manifest 字段：

```jsonc
{
  "type": "wasm",
  "wasmMain": "main.wasm",
  "wasm": {
    "apiVersion": "0.1.0",
    "memoryLimitMb": 64,
    "callTimeoutMs": 30000,
    "fs": { "preopens": ["~/Documents/cognia-output"] },
  },
  "author": {
    "name": "Alice",
    "publicKey": "base64(Ed25519 32 字节公钥)",
  },
}
```

校验逻辑落在 `lib/plugin/core/validation.ts` —— `wasmMain` 必须以
`.wasm` 结尾；`apiVersion` 必须是 MAJOR.MINOR.PATCH 形式的 semver；
内存上限 ≤ 4096 MiB；超时 ≤ 600 000 ms；preopens 必须为非空、不含
NUL 字节的字符串。

### WIT 契约 v0.1

`src-tauri/wit/cognia-plugin.wit` 定义了一个名为 `cognia-plugin` 的
world，宿主提供 7 个 import 接口，访客实现 4 个导出：

| 接口                                  | 方向         | 能力 key                          | v0.1 落地情况               |
| ------------------------------------- | ------------ | --------------------------------- | --------------------------- |
| `logger.log`                          | host import  | 始终允许                          | 完整实现                    |
| `notification.notify`                 | host import  | `notification`                    | 仅打日志                    |
| `secrets.{get,set,delete}`            | host import  | `secrets:{read,write}`            | 完整实现                    |
| `process.exec`                        | host import  | `process:spawn` / `shell:execute` | 完整实现                    |
| `clipboard.{read-text,write-text}`    | host import  | `clipboard:{read,write}`          | 占位（v0.2 接入 `arboard`） |
| `ai.generate-text`                    | host import  | `network:fetch`                   | 确定性占位                  |
| `workflow.emit-event`                 | host import  | 始终允许                          | 仅打日志                    |
| `init(config: list<u8>)`              | guest export | —                                 | activate 时调用             |
| `on-event(kind, payload)`             | guest export | —                                 | 由 plugin_wasm_call 调用    |
| `tool-execute(name, args)`            | guest export | —                                 | 可选                        |
| `workflow-node-execute(kind, inputs)` | guest export | —                                 | 可选                        |

bindgen 调用集中在 `since_v0_1.rs` 中一次性完成。每个生成出的 `Host`
trait 都在 `HostState` 上实现；每个方法在调用真正的 OS API 前，
都先通过 `capabilities::<area>::check_*` 助手查 `CapabilitySet`。

### 能力授权（Zed 风格）

权限通过 **manifest 声明** + **安装时一次性授权**。我们刻意不做"每次调用
弹一次"那种模式 —— Zed 的实践显示这种模式实际上变成噪音。复用现有的
`permission-guard.ts` 声明式授权账本即可。

`WasmCapabilityGrantSheet` 在安装时打开，按类别分组展示 manifest
permission、作者 Ed25519 指纹（如已签名）、附加 preopens。用户勾选后
点击 **Install with selected access**：

1. `applyWasmCapabilityGrant` 把每个授权权限写入 permission-guard 的
   内存账本，`grantedBy: "user"`。
2. 附加 preopens 落到 `localStorage` 的 `cognia:wasm-plugin:preopens`
   字段。Rust 宿主在 `plugin_wasm_activate` 时读取该清单，构建
   `WasiCtxBuilder` 时一并加入。

卸载时 `clearWasmCapabilityGrant` 会同时撤销所有授权并清空 preopens
记录，与现有 `revokePluginPermissions` 行为保持一致。

### 资源限制

每个 WASM 插件实例都跑在全新的 `Store<HostState>` 上：

- **线性内存上限**：默认 64 MiB，可通过 `manifest.wasm.memoryLimitMb`
  配置（≤ 4096）。
- **table 元素上限**：10 000（v0.1 固定）。
- **instances / tables / memories**：1 / 4 / 1。
- **Epoch 中断**：`Config::epoch_interruption(true)`，截止 tick 由
  `manifest.wasm.callTimeoutMs`（默认 30 s）计算。
- **后台心跳**：每个进程仅一个 tokio 任务，每 100 ms 调用一次
  `engine.increment_epoch()`（`engine::EPOCH_TICK_MS`）。
- **单次调用超时**：默认 30 s 墙钟，`process.exec` 内部还用 `wait-timeout`
  额外包了子进程，防止 OS 子进程的生命周期超出插件调用。

`StoreLimitsBuilder::memory_size(bytes)` 通过
`store.limiter(|s| &mut s.limits)` 绑定到 store；越限会产生 wasm trap，
访客侧看到的就是类型化的 out-of-memory 错误。

### ABI 版本

契约版本通过 `cognia:api-version` 自定义节嵌入到产出的 `.wasm` 中。
打包时由 `cognia plugin build` CLI 注入。加载时
`engine::parse_plugin_api_version` 读取自定义节；`host::version_linker`
按 MAJOR.MINOR 路由到 `wit/since_v0_<MINOR>.rs` 中对应的链接器。

v0.x 阶段 **MINOR** 变更视为破坏性变更（遵循
[0.x semver 约定](https://semver.org/#spec-item-4)）；v1.x 之后 MAJOR
才是破坏性信号。`api_version_compatible` 是这个规则的代码化。
当插件声明的 MINOR 找不到对应链接器时，加载阶段直接报
`"no linker registered for v0.N.x"`，永远不会出现半实例化的插件。

### 安装源

三种来源对应三条命令：

| 源       | Rust 命令                                    | TS 入口                                                      | 信任检查                                                          |
| -------- | -------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------- |
| 本地文件 | `plugin_install`（已有）→ `plugin_wasm_load` | `installWasmPluginFromLocalFile` + `InstallWasmPluginButton` | 仅做 manifest 校验                                                |
| HTTP URL | `plugin_wasm_install_from_url`               | `installFromUrl` + `PluginSignedInstallFromUrlDialog`        | Ed25519 detached 签名 + `trustedPublishers` 账本                  |
| Git 仓库 | `plugin_wasm_install_from_git`               | `installFromGit`                                             | 运行时探测 `cargo-component`；缺失时抛 `GitToolchainMissingError` |

签名包以 `<bundle>.zip` + `<bundle>.zip.sig` 形式分发。签名只覆盖 zip
原始字节（而非现有 `plugin_create_signature` 那种 `(id || version)`
前缀，详见 `src-tauri/src/plugin_api/signature.rs` 中的
`plugin_verify_detached_signature`）。首次安装会弹出指纹确认；接受后
`trustedPublishers`（v29 schema）记录该公钥，后续来自同一作者的更新
将自动信任。

---

## 影响

- **作者获得完整工具链**。插件作者只需安装一次 Rust + `cargo-component`，
  之后用 `cognia plugin new / build / sign` 即可基于 WIT 契约脚手架
  自己的插件。产物可复现、可签名。
- **安全模型由引擎而非 API 表面强制**。未获 `process:spawn` 的 WASM 插件
  无法 spawn 子进程；`process::check` 在 `std::process::Command` 之前
  生效；即使绕过了，WASI 沙箱也只暴露已 preopen 的目录。
- **Web 模式优雅降级**。`isWasmHostAvailable()` 在 webview 中返回 false；
  loader 返回带 warn 日志的占位 activate hook；UI 安装入口直接提示
  "需要 Tauri 桌面端"。
- **wasmtime 体积较大**。引入 wasmtime 26 + cranelift + WASI Preview 2
  让 debug 产物大小增加约 25 MB。release 产物通过 cranelift 的懒编译
  分摊；引擎本身整个进程只构造一次。
- **MSRV 从 1.77.2 抬到 1.82**。`wasm32-wasip2` 访客 target 要求 ≥ 1.78；
  wasmtime 26 与 ed25519-dalek 2 等传递依赖也要求 ≥ 1.78。

---

## 推迟事项

- **AI generate-text** 当前为确定性占位。v0.2 将通过 Tauri 事件路由到
  `lib/ai/*`，使用用户配置的 provider 链处理实际请求。
- **Clipboard** 读写当前都是占位（read 返回空、write 仅打日志）。
  v0.2 接 `tauri-plugin-clipboard-manager`。
- **Notification** 通知目前进 `log::info!`，而非 OS toast。
  v0.2 接 `tauri-plugin-notification`。
- **Workflow `emit-event`** 当前仅记录日志。v0.2 通过现有的
  `lib/plugin/bridge/workflow-integration.ts` 把事件路由回工作流运行时。
- **Sigstore** _不_ 使用；v0.1 只验证 manifest 中绑定的 Ed25519 公钥。
  若用户社区需要可在 v0.2 作为可选后端引入。
- **多版本宿主链接器**：脚手架到位但只注册了 v0.1.0。v0.2 时把
  `since_v0_1.rs` 复制为 `since_v0_2.rs`，并在
  `host::version_linker` 中加分支。

> **已被取代。** 除 Sigstore 外，上述每一条都由下方 2026-08-03 修订交付。
> Sigstore 仍然刻意未实现。

---

## 修订 — 2026-08-03（宿主 API v0.2.0，硬切换）

交付了 `## 推迟事项` 中除 Sigstore 外的全部五条。**Sigstore 仍未实现，
也没有为它搭任何后端脚手架** —— 那一条原样保留。

### 反转：多版本链接器是迁移工具，不是兼容承诺

原设计按契约版本各注册一个链接器，让老插件可以一直跑下去。v0.2**只**
注册 `0.2.0`。加载 v0.1 插件会以 `UPGRADE_REQUIRED` 失败，错误信息里点名
插件、给出读到的版本，以及重建所需的五个步骤。

为什么是硬切换而不是兼容垫片：`notification.notify` 从"无返回值"改成
`result<_, string>`，这改变了组件的 import 类型。v0.1 的 guest 二进制根本
无法与 v0.2 world 链接 —— 所谓"兼容"意味着永久维护第二套宿主实现，而不是
一层垫片。目前还没有已发布的第三方 WASM 插件，迁移成本就是一次
`cargo component build`；而这个成本只会越来越高。

版本来自 `cognia:api-version` **wasm 自定义段**，绝不来自 manifest。完全
没有该段的二进制保持原有的"格式错误"报错，并且明确**不**报
`UPGRADE_REQUIRED` —— 有测试钉住这一点：如果作者的工具链压根没写入该段，
却告诉他"请重建到 0.2"，只会把人引向完全错误的方向。

### 反转：冻结 v0.1 需要的是"不编译"，而不只是"不注册"

`since_v0_1.rs` 用完整结构体字面量构造 `HostState`，因此新增 `services`
字段会强迫我们去改一个刚刚宣布逐字节冻结的文件。源码被移出模块树，放到
`crates/cognia-plugin-runtime/frozen/v0_1/` —— `rustc`、`clippy`、
`cargo fmt` 都不会访问那里。校验清单
（`scripts/gates/frozen-wasm-api.json`，闸门 `pnpm lint:frozen-wasm-api`）
做三个方向的审计：条目匹配、无未登记文件、无缺失条目；crate 内另有一个
`include_bytes!` 测试，为从不跑 node 闸门的贡献者兜住这层冻结。

### 新增：capability 优先的有界 IPC 与稳定错误词表

每个 `result<..., string>` 错误现在都带机器可解析的
`"<CODE>: <message>"` 前缀。`<CODE>` 取自 `CAPABILITY_DENIED`、
`INVALID_REQUEST`、`PAYLOAD_TOO_LARGE`、`TIMEOUT`、`CANCELLED`、
`HOST_UNAVAILABLE`、`PROVIDER_ERROR`、`WORKFLOW_REJECTED`。Guest 用
`split_once(": ")` 分支；在 0.2 契约的生命周期内代码稳定，文案不保证稳定。

**来自**渲染端的代码会经过一层映射重新解析，未知代码降级为
`PROVIDER_ERROR`，因此被攻陷的渲染端无法伪造 `CAPABILITY_DENIED`（
`UPGRADE_REQUIRED` 也被显式过滤）。

宿主服务通过 `WasmHostServices` trait 进入沙箱，其访问器是**逐能力的
`Option`**。正是这一点让"没有剪贴板后端的宿主返回 `HOST_UNAVAILABLE`、
且不影响其他能力"成为机制上的必然，而不是需要人去记住的约定。进程级
`OnceLock` 被否决：cargo 在同一进程内以并行线程跑单测，那会让"桌面端提供
剪贴板"和"headless 返回 `HOST_UNAVAILABLE`"两个测试无法共存于同一个二进制。

每个 host 实现的闸门顺序是固定的：**capability 检查 → 参数校验 → 服务查找
→ bridge 查找 → 负载大小 → 派发**。在全部通过之前，不分配 pending 状态、
不发事件、不碰任何原生 API。

### 新增：渲染端桥，以及为什么取消是关键路径

`ai.generate-text` 与 `workflow.emit-event` 由一座桥
（`wasm/bridge.rs` + `lib/plugin/wasm-bridge/`）应答，结构上与 CLI bridge
平行，但拥有自己的通道、pending 表、响应命令，以及 CLI bridge 没有的插件
身份绑定。

`resolve` **在持锁状态下、且在移除条目之前**比对插件身份。先移除再比对会
让有 bug 的或恶意的渲染端通过猜测 id 取消另一个插件的在途请求 —— 一种跨
插件的拒绝服务。

取消不是锦上添花。`Store::set_epoch_deadline` 只在 wasm 执行点触发陷阱，
而一个正在等待渲染端的 host import 并不在执行 wasm，因此 epoch 中断约束不
到它；同时 `plugin_wasm_call_for_state` 在整个 guest 调用期间持有 per-plugin
互斥锁。没有 `cancel_plugin`，在一次 30 秒的 AI 调用中途 deactivate 会让
一个活的 store 泄漏最长 30 秒。所以它在 `WasmPluginHost::deactivate`
**之前**调用，而不是之后。

渲染端对每个请求恰好回一次响应（取消导致的中止也算），因此宿主必须容忍
并丢弃一个它已经因自身超时而结算掉的请求的响应。

### 新增：两处 capability 重新设闸

| 能力面 | v0.1 | v0.2 |
| --- | --- | --- |
| `ai.generate-text` | `network:fetch` | **`ai:chat`** |
| `workflow.emit-event` | _（无闸门）_ | **`extension:workflow`** |

`network:fetch` 授予的是裸的出站 HTTP。花掉用户的模型额度、并经过宿主的
PII 脱敏闸门，是一个独立的授权决定，因此配一个独立的 capability。
`emit-event` 在只写一行日志时无需设闸；v0.2 它真的会重新进入工作流运行时。
硬切换正是修这两处的零迁移成本时机。

因此 `WASM_UNIMPLEMENTED_PERMISSIONS` 现在是 `[]`。若不改，安装授权面板会
把已经可用的剪贴板能力渲染成永久禁用，并且永远不会把它们加进已授权集合
—— 变成"Rust 里实现了，实际却够不着"。

### 修复：一处自 v0.1 带下来的负载泄漏

`since_v0_1.rs` 以 info 级别记录通知的 `title` 与 `body`。v0.2 两者都不记，
无论全文还是片段；同一规则现在覆盖剪贴板内容、AI prompt 与补全、以及工作流
负载（只记长度）。Bridge 诊断信息经由封闭的 key 白名单渲染，并有测试钉住：
用含哨兵字符串的负载构造诊断，断言哨兵绝不出现。

---

## 参考

- WIT 契约：`src-tauri/wit/cognia-plugin.wit`
- 方案：`~/.claude/plans/rust-wasm-zed-swirling-planet.md`
- Zed 扩展宿主：[zed-industries/zed](https://github.com/zed-industries/zed)
  `crates/extension_host/src/wasm_host.rs`
- wasmtime 组件 bindgen 宏：
  <https://docs.wasmtime.dev/api/wasmtime/component/macro.bindgen.html>
- `cargo-component`：
  <https://github.com/bytecodealliance/cargo-component>
- WASI Preview 2 接口：<https://wasi.dev/interfaces>
