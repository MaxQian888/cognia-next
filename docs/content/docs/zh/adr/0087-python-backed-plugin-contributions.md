---
title: "0087 — Python 支持的插件贡献"
description: "让能力契约如实声明 Python 能执行什么,并通过一层共享 seam 把 module-bridge 贡献路由进插件的 Python 子进程。"
---

# ADR 0087 — Python 支持的插件贡献

**状态:** 已接受
**日期:** 2026-07-21

## 背景

Python 插件运行时(`crates/cognia-plugin-runtime/src/python/`)早已上线:每插件一个子进程、stdio 上的 NDJSON、嵌入式 `host.py`、venv 管理,以及 `cognia-plugin-sdk` 作者包。`tools`、`hooks`、`configuration` 确实在那里执行。

其余部分则是半真半假。一次插件面审计发现能力集里横着一条**代码里从未命名过**的硬边界:

- **声明式能力**(`skills`、`subagent`、`character-pack`、`theme-pack`、`pet-item`、`workflow-template` 等)进 manifest 就是纯 JSON,宿主消费时不关心是什么语言写的,**Python 本来就能用**。
- **module-bridge 能力**(`ocrProviders`、`aiProviders`、`connectors`、`workspaceBackends` 等)解析出来的是一个**带活方法的 JS 对象** —— `provider.extract(...)`、`backend.clone(...)`、`adapter.send(...)`。每个 bridge 动态 import 一个 JS `entry` 并调用具名 `export`。纯 Python 插件交不出 JS 对象。
- **UI 能力**(`views`/tree-view、`messageRenderers`、`modalMounts`、`contextPanels`)需要渲染进程里的 React 组件。子进程没有 DOM。

**说谎的不是运行时,而是契约和 SDK。** `plugin-sdk/python` 提供了 `define_ocr_provider()`、`define_connector()` 等,让 Python 作者能写出看似可用的 provider;`define_connector` 甚至接收一个 `factory: str` 去指向一个不可能存在的 JS 符号。`PluginCapabilityContract.pythonSdk` 为 Python 永远无法执行的能力列出了 Python SDK 文件,而 proof 审计**要求**每个 `supported` 能力都填该字段——等于契约在**主动推动**每个能力去宣称支持 Python。与此同时 `cognia plugin lint` 又会直接拒绝这类插件(`manifest.contributions.javascript.unsupported_for_python`),作者面对的是一个"SDK 邀请你写、linter 拒绝你交"的局面。

## 决策

两步,顺序不可颠倒。

### 1. 让契约声明 Python 可执行性

`packages/plugin-sdk/contract/catalog.json` 早已给每个贡献分类了 `execution`(`host` / `javascript` / `conditional` / …)。我们**没有**新建一张平行表,而是给同一批记录加了一个轴:

```
manifestContributions[].pythonExecution: "supported" | "experimental" | "unsupported"
```

缺省即 `"unsupported"`。它只对 `javascript` / `conditional` 字段有意义 —— `host` 类贡献是数据,与语言无关。该轴经 `scripts/plugin/generate-contract.mjs` 流入两份镜像(`crates/cognia-cli/src/engine/contract.rs`、`_generated_contract.py`),因此 Rust linter 与 Python SDK 自检**在构造上必然一致**。

`lib/plugin/contracts/plugin-capabilities.ts` 的 `capabilityPythonExecution()` 从这些记录派生逐能力真相,proof 审计也改为**只在 Python 确实能拥有该能力时**才要求 `pythonSdk`。

### 2. 执行统一走一层 seam

`lib/plugin/bridge/_shared/python-backed-proxy.ts` 构造各 bridge 期待的活对象,每个方法都经由现有的 `plugin_python_call` RPC 往返。**不新增 Rust command,不新增协议方法。**

**backend 判定**(三处逐字保持一致 —— `validation.ts` 的 `effectiveContributionBackend`、seam 的 `isPythonBackedContribution`、以及 Rust lint):

1. 每条目显式的 `backend: "js" | "python"`;
2. 声明了 JS 模块路径(`entry`)—— **写下它本身就是 JS 意图的声明**,绝不静默忽略;
3. 插件类型(`python` → `"python"`,其余 → `"js"`)。

规则 2 的存在是因为初稿曾无条件把 `type: "python"` 插件的贡献默认成 Python,那会**静默丢弃作者明写的 `entry`**。

**流式**以 seam 生成的 `streamId` 关联,而非协议自身的 `call_id`:后者在 Rust NDJSON 层内部分配,**永不到达渲染进程**。Python 发出 `chunk {streamId, value}` / `chunk_end {streamId}`。

**入站推送**复用 `plugin:python` 事件通道。`cognia.emit(id, channel, payload)` 产生 `emit` 帧,由 `subscribePythonContributionPush` 投递给归属 bridge。

**作者侧**只是一个装饰器;`describe()` 返回 JS 工厂本会内联返回的纯数据描述符:

```python
@cognia.contribution("tesseract")
class Tesseract:
    def describe(self):
        return {"label": "Tesseract", "category": "local", "credentialKeys": []}

    def extract(self, image, ctx=None):
        return {...}
```

## 能力分档

| 档 | 能力 | `pythonExecution` |
| --- | --- | --- |
| 请求/响应执行器 | `media`(ocr)、`ai-provider`、`workspace-backend`、`routing-strategy`、`deployment-filter`、`context-provider`、`session-importer`、`protocol-adapter`、`external-agent-adapter` | `supported` |
| 别扭的执行器 | `connectors`、`chat-middleware`、`terminal-completion` | `experimental` |
| React UI | `tree-view`、`message-renderer`、`modal-mount`、`context-panel`、`configComponent` | `unsupported` |
| 数据 / 资产 | `fonts`、`wallpapers`、`density-preset`、`scheduler` 及全部声明式能力 | 不适用(`execution: host`) |

## 阻抗不匹配及其处理

以下正是第二档标 experimental 的原因。**没有一处是用桩糊弄的。**

**同步方法。** `ProtocolAdapter.isConnected()`、`PlatformAdapter.health()`、`PlatformAdapter.a2uiCapability()` 都是同步的,IPC 往返无法满足。wrapper 在宿主侧于 `connect`/`disconnect` 与 `start`/`stop`/`send` 前后跟踪状态,并缓存一次性 `describe()` 取得的 A2UI 矩阵。

**不可序列化的上下文。** `AdapterContext` 携带活函数(`emit`、`logger`、`secrets`、`signal`)。只有可序列化的身份信息下发给 Python;入站 `emit` 路径经推送通道**反向**回来,由 wrapper 转发进 connector 总线。

**续延。** `ChatMiddleware` 接收 `next` —— 一个运行剩余链路的 JS 闭包。把它传过边界需要宿主在第一个调用挂起时发起**嵌套的** `plugin_python_call`,那套可重入机制属于 SDK 而非 bridge。改为:Python 中间件实现 `before`/`after`,由 wrapper 合成 around 语义(改请求、改响应、短路)。**代价:** 无法多次调用续延,因此重试/fan-out 控制流仍是 JS-only。

**延迟。** 内联终端补全有紧的延迟预算,每次请求多付一次 IPC 往返。

## 执法

分级,且 Rust linter 与运行时校验器**完全一致**:

- `type: "python"` 插件声明 `unsupported` 能力 → **error**(`manifest.contributions.javascript.unsupported_for_python`);
- python-backed 的 `experimental` 能力 → **warning**(`manifest.contributions.python.experimental`);
- `entry`/`export` 仅在条目解析为 JS backend 时才必填。

experimental 档的**执行**另由 `lib/plugin/python/experimental-flag.ts` 门控,它从契约读取档位而非维护手写清单 —— 把某能力改成 `supported` 会自动退休该门。**默认关闭**:注册始终发生(以保持 manifest、linter 与插件详情 UI 诚实),只有执行中的 bridge 才查询该 flag。

## 影响

- 纯 Python 插件可以在**完全没有 JavaScript** 的情况下拥有那九个 `supported` 能力。
- `hybrid` 插件应显式设置 `backend`:省略时解析为 `"js"`,这通常不是 hybrid 作者对 Python handler 的本意。
- 保留的 dispatcher `__cognia_dispatch_contribution__` 在 `host.py` **和** `commands.rs` 两处都豁免了私有名守卫;以 `_` 开头的插件符号**仍被拒绝**。
- `get_info()` / `import_main` 现在上报 `contribution_count`,注册为空的插件因此可见,而不是静默失效。
- 已用真实解释器端到端验证:`first_party_python_runtime_demo_contributions_dispatch` 加载 `plugins/cognia-python-runtime-demo` 并分发其 OCR、workspace 与 connector 贡献。

## 备选方案

**在 `PLUGIN_CAPABILITY_CONTRACTS` 上另建 `pythonRuntime` 表** —— 最初计划的做法。在审计发现 `execution` 已经建模了同一维度后被否决:第二张表会与第一张漂移,且到不了 Rust 与 Python 镜像。

**逐 bridge 定制接线** —— 对那九个干净能力否决(代理是统一的),仅在契约确有差异处采纳(connector、external-agent adapter、chat middleware)。

**为 chat middleware 实现真正的续延协议** —— 推迟。它需要 `host.py` 的可重入调用处理与一个 resume RPC;`before`/`after` 拆分在不假装的前提下覆盖了现实用例。
