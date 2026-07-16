---
title: ADR-0076 — 本地 provider 管理面传输层
description: "本地 provider 的管理调用一律走 Rust HTTP 代理,而非 renderer fetch 或专用 Tauri 命令;流式 pull 是唯一例外;packages/provider-core 必须由宿主注入 runtime adapters。"
---

# ADR-0076 — 本地 provider 管理面传输层

**状态**: Accepted (2026-07-16)

## 背景

Cognia 支持十个本地推理 provider(ollama、lmstudio、llamacpp、llamafile、vllm、
localai、jan、textgenwebui、koboldcpp、tabbyapi)。它们的**配置面是完整且正确的** ——
inline provider 条目、设置卡片、双语文案一应俱全。管理面则不然,而它失效的**形状**
恰好解释了为什么长期无人报障。

**架构是不对称的**:聊天能用,管理面不能:

| 路径     | 运行位置       | CSP    | 实际结果 |
| -------- | -------------- | ------ | -------- |
| 聊天发送 | Node sidecar   | 无     | 可用     |
| 管理面   | renderer       | 生效   | 全死     |
| 嵌入     | renderer→invoke| 不适用 | 抛异常   |

用户的时间都花在能用的那条路径上,坏掉的那条一年碰不了几次 —— 于是一个彻底失效的
界面看上去健康了好几个月。

三重失效叠加,缺一不可,必须全部修复:

1. **Rust 侧零实现。** `packages/provider-core/.../ollama.ts` 有八个
   `invoke("ollama_*")` 调用。在全部 543 个 `.rs` 文件里搜 `ollama` 零命中 ——
   这些命令**一个都没写过**。其中多数没有 try/catch,桌面端每次调用直接抛
   `Command not found`。`local-provider-service.ts` 的同类 invoke **有** try/catch,
   所以它不是响亮地失败,而是在每一次桌面运行中**静默跌落到 HTTP** —— 正好掉进失效 2。

2. **CSP 封死了兜底。** `tauri.conf.json` 的 `connect-src` 是
   `'self' ipc: http://ipc.localhost ws: wss:` —— 没有 `http:` scheme,
   `tauri.macos.conf.json` 也无覆盖。renderer 打 `http://localhost:11434` 在离开
   WebView 之前就被拦截;**loopback 不属于 `'self'`**。同一份 CSP 此前已经静默杀死了
   OTLP、Langfuse 和通用 `remote` 三个日志 transport(见 ADR-0074),它们上线数月
   一个字节都没发出去过。

3. **hook 层是桩。** `useLocalProvider` 的 pull/delete/stop 全是 `deferred()` no-op,
   只设置一个错误字符串;而 `useLocalProvidersScan` —— 设置页扫描按钮**唯一的数据源**
   —— 返回一个冻结的空 Map 和 `noopScan`。

有两件事让这一切保持隐形:

- **`pnpm dev` 没有 CSP。** 开发期走的正是兜底路径,而且它能用。
- **测试为幻觉背书。** `ollama.test.ts` 从不模拟 Tauri 宿主,`isTauri()` 恒为 false,
  invoke 分支零覆盖。`local-provider-service.test.ts` 更糟:它 **mock 了 `invoke`**,
  于是十二个测试断言「不存在的命令被以正确的参数调用了」—— 并且全部通过。

`packages/provider-core` 早就暴露了 `setProviderCoreRuntimeAdapters` 供宿主注入
`isTauri` / `proxyFetch` / loggers,但它**零生产调用点** —— 所以 `proxyFetch` 恒等于
自带的 `defaultProxyFetch`,也就是一个裸 `fetch`。

## 决策

- **renderer 通过 Rust 访问本地服务,走 `proxyFetch`。** 所有非流式管理调用
  (status、tags、show、delete、ps、copy、embeddings)经由既有的
  `proxy_http_request` 命令隧穿,reqwest 不受 CSP 与 CORS 约束。补八个 Rust 命令去
  复活 `invoke` 不会带来任何 `proxy_http_request` 尚不能做的事,却要付出八个命令的
  维护成本。

- **这条路径上永不设置 `blockPrivateHosts`。** 该标志即 Rust 侧读取的 `blockPrivate`
  SSRF 护栏,默认关闭;一旦打开就会拦掉 loopback —— 而 loopback 正是这座桥存在的
  全部理由。适配器**原样透传** `proxyFetch`(不做包装),因此没有任何包装层能注入它,
  并有测试钉住这个身份等式。

- **`ProviderCoreRuntimeInitializer` 在启动时注入一次**,位于 deferred-boot 包内、
  `RoutingRuntimeInitializer` 与 `GatewayProvider` 之前,沿用 `provider-routing` 的
  先例。headless brain 宿主经 `lib/headless/runtimes/initializers.ts` 注入同一份
  adapters。**没有这一步,provider-core 保持惰性默认值,整个管理面在桌面端就是死的。**

- **流式 pull 是唯一的 Rust 例外。** `/api/pull` 是贯穿整个下载过程的 NDJSON 长连接,
  而 `proxy_http_request` 返回 buffered `body: String` —— 调用方会静默数分钟,然后在
  下载**结束之后**一次性收到全部进度行。`ollama_pull_model_stream` 在服务端流式读取
  并逐行发事件,用 `pullId` 隔离,使并发 pull 不会串流。NDJSON 读取器落在
  `cognia-net::ndjson_stream`,是 `http_download` 的兄弟 —— 同一个「边流边报」的
  范式,不同的 sink。

- **能力靠探测,不靠猜。** `/api/show` 返回 `capabilities` 数组;其八个取值由上游
  `types/model/capability.go` 的枚举固定,而已发布的 OpenAPI schema 并未枚举它们。
  真实 context length 来自 `model_info` 中一个**带架构前缀**的 key
  (`llama.context_length`、`qwen2.context_length`、`gemma4.context_length`……),
  因为 Ollama 自己的 GGUF 读取器会把 `general.architecture` 拼到任何位于 `general.`
  与 `tokenizer.` 命名空间之外的 key 前面。**硬编码 `llama.` 会在
  Gemma/Qwen/DeepSeek 上静默返回 undefined。** 名称子串匹配仅作为老服务器的兜底保留,
  且其结果带 `inferred: true`,确保猜测永远不会被当作事实呈现。

- **嵌入改用 `/api/embed`,批量。** 废弃的 `/api/embeddings` 只接受单个 `prompt`,
  这正是「每条文本一次 HTTP 往返」的成因。`/api/embed` 的 `input` 原生接受数组,响应
  恒为二维 `embeddings`,于是 N 条文本 = 一次请求。**长度与输入不匹配的响应会被拒绝**,
  而不是错位对齐到错误的文本上。

- **UI 不宣称自己不知道的事。** 两个后果:
  - `InstallCheckResult.installed` 改为三态。服务器可达 ⇒ 既已安装**又**在运行;
    **沉默什么也证明不了** ——「没装」「装了没启动」「跑在别的端口」三者无从区分 ——
    所以不可达时返回 `undefined`,绝不返回 `false`。设置页那个「已安装」计数与「运行中」
    源自同一个值、因而**可证明永远相等**,已移除;只保留「运行中」。
  - 取消 pull 停止的是**上报**,不是下载。Ollama 服务端根本无法取消 pull —— 断开连接
    后传输仍会跑到完成([ollama#13142](https://github.com/ollama/ollama/issues/13142),
    仍 open)—— 因此不提供取消命令,UI 如实告知「下载仍在后台继续」,而不是暗示字节
    已经停了。

## 影响

- 本地 provider 管理面在打包桌面端**首次真正可用**:扫描能探测到运行中的服务、模型
  列表能加载、删除与停止真正生效、pull 有真实进度、Ollama 嵌入在 Twin/RAG 路径上
  不再抛异常。
- 未来所有 `provider-core` 的网络调用都免费继承 Rust 传输 —— **但仅当 initializer 保持
  挂载**。它对启动顺序敏感,由一个挂载顺序测试钉住;一旦被摘掉,打包构建下整个管理面
  会再次静默失效,而 `pnpm dev` 依旧一切正常。
- 批量嵌入把 Ollama 的请求数从 N 降到每批 1 次。返回短数组的服务器现在会**响亮失败**,
  而不是悄悄污染检索质量。
- `localai` 与 `jan` 声明了 `canPullModels` / `canDeleteModels`,但只有 Ollama 的协议
  被实现;这些调用会报告失败,而不是去 invoke 不存在的命令。实现它们各自的 gallery API
  **明确不在本次范围**,选择标注而非顺手扩大。
- 死 invoke 分支已清除,「mock 的 `invoke` 为未写的命令背书」这一类 bug 在本模块不会
  重演。测试现在断言的是**传输层**(代理 vs 裸 fetch),而不是命令名。

## 备选方案

- **补齐那八个 Rust 命令。** 否决:`proxy_http_request` 已经覆盖了每一个非流式调用。
  这是用八个命令的维护成本换零能力增益。
- **放宽 `connect-src` 允许 `http:`。** 否决,且根本行不通:用户的服务器 URL 是运行时
  值,而 CSP 是构建期常量 —— 策略无法表达它,除非用通配符,那会削弱应用内每一个 origin
  的安全性。ADR-0074 在 OTLP 上得出的是同一个结论。
- **用 `/api/tags` → `details.families` 检测 vision**,作为逐模型 `/api/show` 的省流替代。
  **依据证据否决**:上游只把 base model 层的 architecture 追加进 `ModelFamilies`,
  从不追加 projector 层的,因此 `clip` 根本不会出现在那里,只有 `mllama` 会。这条捷径
  会静默漏报 vision 模型。
