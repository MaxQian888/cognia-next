# 本地模型提供商 (macOS) — 缺口修复与 Apple Silicon 补齐计划

**日期**: 2026-07-16
**状态**: 待评审(未实施 —— 下文每一项都是已验证的缺陷或缺口,不是设想)
**范围**: `packages/provider-types/src/{local-provider,ollama}.ts`、`packages/provider-core/src/providers/{ollama,local-providers,local-provider-service,runtime-adapters}.ts`、`packages/provider-embedding/`、`hooks/provider/use-local-provider.ts`、`hooks/ai/use-ollama.ts`、`components/settings/provider/`、`lib/network/proxy-fetch.ts`、`src-tauri/`、`crates/cognia-net/`
**参考 ADR**: 0067(Rust crate 分解)、0068(前端包抽取 —— `packages/provider-*` 由此而来)、0025(统一订阅 —— provider 目录的邻居)、拟新增 **0076**(0075 已被语音/TTS 计划占用)

---

## 0. 如何使用本文档

每个工作项自成单元:**问题 → 证据 → 修法 → 验收**。除非标注 **依赖**,否则彼此独立,一项一个 commit。

### 0.1 置信标签 —— 动手前先读这节

沿用 `2026-07-16-voice-tts-subsystem-remediation.md` / `2026-07-16-otel-native-telemetry.md` 的约定。**标签不是装饰。**

| 标签            | 含义                                          | 你必须做什么                                   |
| --------------- | --------------------------------------------- | ---------------------------------------------- |
| **[CONFIRMED]** | 本文作者亲手 grep / 读代码核实,file:line 已对 | 可信,但行号会漂 —— **按符号重新定位,别按行号** |
| **[AGENT]**     | 由 subagent 提供证据,作者未独立复核           | **动手前先自行复核这条具体主张**               |
| **[OPEN]**      | 真正未决,需要人来拍板                         | **不要默默替它做决定**,见 §4                   |

**本文没有 [VERIFIED-LIVE] 标签,因为一次实机验证都没做。** 见 §0.3 —— 这是本计划最大的证据缺口。

### 0.2 证据标准(不可妥协)

本仓已经吃过两次「假零」的亏(见 OTel 计划 §0.2)。本文的核心主张是一个**零匹配**(「Rust 侧没有任何 Ollama 实现」),因此已跑阳性对照:

```bash
rtk grep -rln "tauri::command" src-tauri/src   # → 5+ 文件   (工具在工作)
rtk grep -rlin "ollama" src-tauri/src crates   # → 0         (零是真的)
find src-tauri crates -name "*.rs" -not -path "*/target/*" | xargs grep -lin "ollama"  # → 0 (换工具复核)
find src-tauri crates -name "*.rs" -not -path "*/target/*" | wc -l                     # → 543 (基数不为零)
```

同理,「`ollama.test.ts` 零 mock」这条也跑了阳性对照:同一模式在兄弟文件 `local-providers.test.ts:4` **命中 1 处**,证明模式与工具都正常。

**凡本文出现「零 / 不存在 / 未使用」的主张,均已跑阳性对照。你复核时请照做。**

> **调研中被证伪的一条**:作者一度认为 `lib/network/proxy-fetch.ts:92` 发送 `blockPrivate` 而 Rust 结构体字段是 `block_private`,构成静默失效的 SSRF 护栏。**该结论为假** —— `src-tauri/src/proxy_config/commands.rs` 的该字段带 `#[serde(default, rename = "blockPrivate")]`,接线正确。记录在此是为了说明:**本主题里「看起来像 bug」的东西有真有假,必须读到属性宏那一行为止。**

### 0.3 唯一的实机证据缺口 —— 先读这里

**CSP 阻断(W1 的全部前提)是从配置 + 代码路径推导的,不是跑出来的。** 推导链:

1. `src-tauri/tauri.conf.json:35` 的 `connect-src` 无 `http:` scheme [CONFIRMED]
2. `src-tauri/tauri.macos.conf.json` 无 CSP 覆盖(`csp|security` → 0 匹配)[CONFIRMED]
3. ⇒ 打包后 renderer 打 `http://localhost:11434` 应被拦截 **[推导,未实测]**

该推导与 memory 中已记录的同类事故(`tauri-csp-blocks-renderer-egress`:OTLP/Langfuse/remote 三个 transport 从没出过数)**同根因**,可信度高 —— 但**动手前请先跑 §5.0 的实机验证**。若 CSP 推导为假,W1/W2 的修法仍然正确(死 invoke 就是死 invoke),但优先级排序要重排。

---

## 1. 研究结论(先读这节,它推翻了三个假设)

### 1.1 假设一「本地模型这块基本没做」—— 错

**配置面是完整且正确的。** 10 个本地 provider(ollama / lmstudio / llamacpp / llamafile / vllm / localai / jan / textgenwebui / koboldcpp / tabbyapi)全部:

- 在 `packages/provider-types/src/provider.ts:700-959` 的 `INLINE_PROVIDERS` 中有真实条目 [CONFIRMED]
- 在设置侧栏、`LocalProviderSettings` 中有真实卡片,分三组(recommended / advanced / specialized)[AGENT]
- i18n 双语齐全(`providers` 命名空间,en + zh-CN 双侧)[AGENT]
- **聊天真的能用** —— 见 1.2

**注意一个反直觉点**:memory 里记的「INLINE_PROVIDERS shadows the catalog」在这里**没有造成伤害**。`provider.ts:2124` 确实 `return { ...merged, ...INLINE_PROVIDERS }`(INLINE 最后展开、整体覆盖),但 10 个本地 provider **全在 INLINE 里**,所以它们存活。代价是 `built-in-provider-catalog.ts:2120+` 的那份本地 provider 定义成了**死代码**,且 baseURL 事实存在三份(见 W12)。

### 1.2 假设二「那就是全都不能用」—— 也错。真相是架构不对称

| 路径         | 运行位置                  | CSP             | 实际结果      |
| ------------ | ------------------------- | --------------- | ------------- |
| **聊天发送** | Node sidecar `ai-sdk.mjs` | **无 CSP**      | ✅ **真能用** |
| **管理面**   | renderer                  | 被 CSP 拦       | ❌ 全死       |
| **嵌入**     | renderer → `invoke`       | 无 Rust handler | ❌ 桌面端必崩 |

`sidecar/dispatch/ai-sdk.mjs:429-430` 的注释直白写着 [CONFIRMED]:

> _"Local engines (ollama, lmstudio, …) always carry a base URL and so pass this check."_

**这个不对称是整件事最重要的事实**:它解释了为什么这个功能能长期以「半可用」状态存在而没人报障 —— 用户最常用的路径(聊天)是好的,坏掉的是他们偶尔才碰的管理面。

### 1.3 假设三「修它要写一堆 Rust」—— 最错

**W1 + W2 让管理面复活,零 Rust。** 逃逸通道早就在仓里,只是从没接线:

- `lib/network/proxy-fetch.ts:39` `tauriProxiedFetch()` → `:84` `invoke("proxy_http_request")` [CONFIRMED]
- `proxy_http_request` 已注册于 `src-tauri/src/lib.rs:847` [CONFIRMED]
- 它**默认允许 loopback**:`commands.rs:202` 是 `if input.block_private == Some(true) && host_is_private(...)`,不传即不拦 [CONFIRMED]
- 而 `packages/provider-core` 的 `setProviderCoreRuntimeAdapters()` **零生产调用点**(仅 `runtime-adapters.ts:61` 定义 + `:72` 测试重置 + 两个 .test 文件)[CONFIRMED]
- ⇒ `provider-core` 的 `proxyFetch` 恒等于 `defaultProxyFetch`(`runtime-adapters.ts:30-45`)= **裸 fetch** [CONFIRMED]

**真正需要 Rust 的只有一件事:流式 pull 进度**(W9)。因为 `proxy_http_request` 返回 buffered `body: String`(`commands.rs:193-196`),扛不住 `/api/pull` 的 NDJSON 流 [CONFIRMED]。

### 1.4 三重失效叠加(缺一不可,全部命中)

1. **Rust 零实现** —— 543 个 `.rs` 搜 `ollama` 零命中,但 `packages/provider-core/src/providers/ollama.ts` 有 8 个 `invoke("ollama_*")` **且无 try/catch**(`:27 :71 :94 :201 :226 :250 :280 :335`)→ 桌面端 100% 抛 "Command not found" [CONFIRMED]
2. **CSP 封死兜底** —— 见 §0.3
3. **hook 层 no-op** —— `hooks/provider/use-local-provider.ts:171/185/186` 的 pull/delete/stop 全走 `deferred()`(`:142-143` 只 `setError`);`:199-204` 的 `useLocalProvidersScan` 返回 `EMPTY_SCAN_RESULTS` + `noopScan`,**而它就是设置页的数据源** → 扫描按钮什么都不做 [CONFIRMED]

**最讽刺的一点**:`local-provider-service.ts:401-530` 的 pull/delete **完整实现(含 HTTP 兜底)从未被任何代码调用** [AGENT]。修法很可能是「接线已有实现」而非「写新实现」。

### 1.5 为什么长期无人发现(双重隐形)

- **测试测的是 macOS 上永远不走的分支** —— `ollama.test.ts` **零 `jest.mock`** [CONFIRMED] → jsdom 下 `__TAURI_INTERNALS__` 不存在 → `defaultIsTauri()`(`runtime-adapters.ts:31`)恒 false → 20 个用例全跑 browser fallback,**invoke 分支零覆盖**。而兄弟文件 `local-providers.test.ts:4` 是 mock 了的。
- **dev 无 CSP** —— `devUrl` 指向 dev server,不注入 CSP,开发时兜底看着是好的。

### 1.6 违反 Working Rule 7(三轴休眠标注)

| 轴           | 状态                                                                     |
| ------------ | ------------------------------------------------------------------------ |
| 类型/注释    | ✅ `use-local-provider.ts:8-9`、`hooks/ai/use-ollama.ts` 均自陈 deferred |
| 测试 pin     | ✅ `use-local-provider.test.ts:151-186` [AGENT]                          |
| **UI inert** | ❌ **Download / Delete 按钮照常可点**,点了只 setError                    |

按项目规则「三缺一 = latent bug」。→ W3。

---

## 2. 工作项

### P0 —— 让管理面真正出网(零 Rust)

#### W1 [P0] 接线 `setProviderCoreRuntimeAdapters`

**问题**:`packages/provider-core` 的 `proxyFetch` / `isTauri` 在生产中从未被注入,导致所有 HTTP 兜底走裸 fetch → 被 CSP 拦。
**证据** [CONFIRMED]:`runtime-adapters.ts:61` 定义、`:72` 测试重置;全仓 `setProviderCoreRuntimeAdapters` 无生产调用点。`lib/network/proxy-fetch.ts:244` 的 `tauriProxiedFetch` 已实现且未被 provider-core 使用。
**修法**:在应用 bootstrap(与其它 initializer 同处,**位置需按 §4-O1 拍板**)调用一次:

```ts
setProviderCoreRuntimeAdapters({
  isTauri, // from @/lib/tauri
  proxyFetch: proxiedFetch, // from @/lib/network/proxy-fetch — 不传 blockPrivateHosts,loopback 需放行
  loggers: { ai: aiLogger },
})
```

**注意**:**不要**传 `blockPrivateHosts: true` —— 本地 provider 的目标就是 loopback。
**验收**:

- 新增 initializer 的同址测试,断言 adapters 被注入(参考现有 initializer 测试范式)
- **实机**:打包构建下,设置 → Providers → Ollama 卡片显示 connected(需 §5.0 先证实 CSP 推导)

#### W2 [P0] 删除 `ollama.ts` 的 8 个死 invoke 分支

**问题**:`invoke("ollama_*")` 全部无对应 Rust handler,且**无 try/catch**,桌面端直接抛。
**证据** [CONFIRMED]:§0.2 的零匹配 + `ollama.ts:27/71/94/201/226/250/280/335`。对比 `local-provider-service.ts:236` 的 invoke **有** try/catch 兜底 —— 同一个包两套风格 [AGENT]。
**修法**:**删除 invoke 分支,统一走 `proxyFetch`**(W1 之后它就是 Rust 代理)。不要「补 Rust 让 invoke 能用」—— 那是把 8 个命令的维护成本引进来换零收益;`proxy_http_request` 已经能做这些非流式请求。
**依赖**:W1(否则 proxyFetch 仍是裸 fetch)。
**注意**:`generateOllamaEmbedding`(`:280`)是 `ollama.ts` 11 个导出里**唯一有真实调用方**的(`packages/provider-embedding/src/embedding.ts:280,361`)[AGENT] —— 它的修复直接决定 Twin/RAG 选 Ollama 嵌入时桌面端是否崩。**优先改这一个。**
**验收**:`pnpm test -- packages/provider-core/src/providers/ollama.test.ts`(改造见 W4)+ 实机跑一次 Ollama 嵌入。

#### W3 [P0] 给休眠 UI 补 inert 标注(规则 7 第三轴)

**问题**:pull/delete/stop 在 hook 层是 `deferred()` no-op,但 UI 按钮可点。
**证据** [CONFIRMED]:`use-local-provider.ts:142-143,171,185,186`。
**修法**:**两种走法,取决于 W5 排期** [OPEN → §4-O2]:

- 若 W5 同期做 → 本项作废(功能真的活了,不需要标 inert)
- 若 W5 延后 → 按钮 `disabled` + tooltip 说明「需要原生绑定,尚未提供」,i18n 双语,并在 `use-local-provider.test.ts` 钉住 disabled 状态

**验收**:组件测试断言按钮 disabled 且有可访问名称。

---

### P1 —— 接线已有实现 + 补上测试盲区

#### W4 [P1] 修 `ollama.test.ts` 的 invoke 分支盲区

**问题**:测试从不 mock Tauri,`isTauri()` 恒 false,invoke 分支零覆盖 —— **这就是三重失效长期隐形的根因**。
**证据** [CONFIRMED]:`ollama.test.ts` 中 `jest.mock|__TAURI_INTERNALS__|isTauri` → 0 匹配;`local-providers.test.ts:4` → 1 匹配(阳性对照)。
**修法**:参考 `local-providers.test.ts:4` 的范式,用 `setProviderCoreRuntimeAdapters({ isTauri: () => true })` 覆盖并断言走代理路径。**W2 之后 invoke 分支应当已不存在** —— 那么本项改为断言「Tauri 下走 proxyFetch 而非裸 fetch」。
**参考**:`jest-gotchas` skill(TDZ / spyOn / Radix 陷阱)。
**验收**:`pnpm test:coverage:changed -- --strict` 对 `packages/provider-core/` 达标。

#### W5 [P1] 接线 scan / pull / delete 到已有的 `LocalProviderService`

**问题**:`useLocalProvidersScan` 是纯 no-op;而 `LocalProviderService.pullModel/.deleteModel` 完整实现却零调用。
**证据**:[CONFIRMED] `use-local-provider.ts:199-204`;[AGENT] `local-provider-service.ts:401-530` 零调用点。
**修法**:让 hook 调用已有 service。**先复核 [AGENT] 那条** —— 若 service 实现确实完整,这是接线而非重写。
**依赖**:W1、W2。
**注意**:pull 的**流式进度**仍不可用(需 W9)。本项只让**非流式**的 scan/delete 活;pull 的进度条在 W9 前应显示为不确定态,**不要假装有百分比**。
**验收**:实机 —— 扫描按钮能探测到本机 Ollama;删除一个模型后列表刷新。

#### W6 [P1] 三个「算了却丢弃 / 恒等 / 忽略」的小 bug

全部 [AGENT],**动手前逐条复核**:

| 编号 | 问题                                                                                  | 位置                                           |
| ---- | ------------------------------------------------------------------------------------- | ---------------------------------------------- |
| W6a  | `latency` / `modelsCount` 算出后硬传 `undefined`,卡片对应渲染分支永不触发             | `local-provider-settings.tsx:125-126, 253-254` |
| W6b  | `installed` 与 `running` 赋同一个值 → UI 两个数字永远相同                             | `local-provider-service.ts:622-625`            |
| W6c  | 扫描时 `new LocalProviderService(providerId)` 不传 baseUrl → 用户改了端口仍打默认端口 | `local-provider-service.ts:619`                |

**验收**:每条一个组件/单元测试钉住。

---

### P2 —— 从「假装知道」到「真的知道」

#### W7 [P2] 真实能力探测(替换手写静态表)

**问题**:当前能力信息是**假的**。
**证据**:

- `getOllamaModelCapabilities`(`ollama.ts:376`)的 `"llava"` / `"vision"` 子串匹配 **零生产调用点** [AGENT] —— **它不是「唯一机制」,它根本不是机制**
- 真正生效的是 `provider.ts` INLINE 里的**手写静态表**;9 个非 Ollama provider 共用一条假条目(`:1225` 声称 `supportsVision: true, contextLength: 8192`),与用户实装模型毫无关系 [AGENT]
- `showOllamaModel`(`ollama.ts:89`)存在但**零生产调用点** [AGENT]

**修法**:调 `/api/show` 读 `capabilities` 数组。**关键细节(业界对标产出,[AGENT] 但已给出 raw source)**:

- `capabilities` 有 **8 个值**,不是 5 个:`completion` / `tools` / `insert` / `vision` / `embedding` / `thinking` / `image` / `audio`(源:`ollama/types/model/capability.go`)
- **真实 context length 的 `model_info` key 是架构前缀的** —— `llama.context_length`、`gemma4.context_length`…… **必须先读 `general.architecture` 再拼 key**。硬编码 `llama.` 会在 Gemma/Qwen/DeepSeek 上静默失效
- 更省的替代:Enchanted 的做法是 `/api/tags` → `details.families` 含 `clip`/`mllama`,**无需逐模型 round-trip**

**验收**:对一个 vision 模型和一个纯文本模型分别断言能力探测结果;context length 用非 llama 架构(如 qwen)验证。

#### W8 [P2] 嵌入改用 `/api/embed`(批量)

**问题**:用废弃的 `/api/embeddings`(单输入),且「批量」是 for 循环串行 HTTP。
**证据**:[CONFIRMED] `ollama.ts:283` 用 `/api/embeddings` + `prompt` 字段;[AGENT] `embedding.ts:361` 的批量是逐条串行。
**修法**:切到 `/api/embed`。差异 [AGENT]:

|          | `/api/embed`(现行)             | `/api/embeddings`(废弃) |
| -------- | ------------------------------ | ----------------------- |
| 输入字段 | `input` —— string **或数组**   | `prompt` —— 仅 string   |
| 响应     | `embeddings: [[...]]` 恒为二维 | `embedding: [...]` 一维 |
| 批量     | ✅ 原生                        | ❌ 一条一请求           |

额外可用参数:`truncate`(默认 true)、`dimensions`(Matryoshka 截断)、`keep_alive`。
**注意**:响应形状变了(一维 → 二维),`generateOllamaEmbedding` 现有的双分支解析(`:301-313`)已经能容忍两种形状,但**批量路径需要新函数**,别硬塞进单条函数。
**验收**:批量嵌入的单测断言**一次** HTTP 请求返回 N 条向量。

#### W9 [P2] 流式 pull 进度(**唯一真需要 Rust 的项**)

**问题**:`/api/pull` 是 NDJSON 流,`proxy_http_request` 返回 buffered `body: String`,扛不住。
**证据** [CONFIRMED]:`commands.rs:193-196` 的 `ProxyHttpRequestOutput { status, headers, body: String }`。
**修法**:新增一个流式 Rust 命令,把 NDJSON 每行作为事件发给前端。**复用范式**:`crates/cognia-net/src/http_download.rs:65` 的 `stream_to_file` + `:70` `on_progress(bytes_done, bytes_total)` 已是成熟的「流式 + 进度回调」实现 —— 但它**写文件**,本项需要 NDJSON 变体,是**借范式不是借函数**。
**参考**:`tauri-rust-reviewer` agent(parking_lot guard 跨 await、detached task 挂住 cargo test、tuple 序列化成数组、命令未注册、capability/ACL 缺项)。
**⚠️ 上游事实(会改变 UX 设计)** [AGENT]:**Ollama 服务端根本无法取消 pull** —— [ollama#13142](https://github.com/ollama/ollama/issues/13142) 仍 open:_"even when clients abort the HTTP connection, the download continues server-side until completion"_,唯一解法是杀进程。所以:

- 「取消」只能是**客户端幻觉**(Open WebUI 就是 download-pool abort)。**要么别提供取消,要么如实告诉用户「已停止显示,下载仍在后台继续」** —— 别撒谎
- **续传是有的**:_"Cancelled pulls are resumed from where they left off"_;但网络**断开**据报会从 0% 重来 —— 续传 ≠ 重连

**验收**:实机 pull 一个小模型(如 `qwen2.5:3b`),进度条走到 100%;中途「取消」后的行为与 UI 文案一致。

---

### P3 —— 业界水准的差异化能力

#### W10 [P3] 下载前的 fit 判定(**无人占领的高地**)

**动机** [AGENT]:业界对标的 10 个应用里 **6 个完全不查内存**(Cherry Studio / AnythingLLM / Enchanted / ChatWise / Witsy / Open WebUI —— 经代码搜索证实,非推测:Open WebUI 搜 `psutil.virtual_memory` 零命中,Witsy 搜 `totalmem` 零命中)。做得最好的是 **Jan**:Fits / May be slow / Won't fit,且**零字节下载**即可判定,并把这点当作隐私/带宽卖点。

**行业公式**(Ollama 是唯一公开的,源:`PredictServerVRAM` in `llm/llama_server.go`)[AGENT]:

```
need   = weights + kv_cache + graph_overhead
weights   ≈ GGUF 文件实际大小       # 比 params×bits/8 准:Q4_K_M ≈ 4.5bpw 而非 4
kv_cache  = 2 × layers × kv_heads × head_dim × ctx × bytes_per_elem   # f16=2, q8_0=1, q4_0=0.5
budget    = MTLDevice.recommendedMaxWorkingSetSize   # <32GB ≈67% RAM,≥32GB ≈75%
verdict   = need < 0.8×budget ? Fits : need < budget ? "May be slow" : "Won't fit"
```

**三个必须抄对的细节**:

1. **必须用 `kv_heads` 而非 attention heads**(GQA 感知)。搞错会在现代模型上高估 **4–8×**
2. Ollama 源码自陈 _"intentionally conservative — it overestimates to avoid VRAM contention"_,并且**先估算、再从 llama-server 日志解析真实值自我校正**。静态公式一定会错
3. **context 才是主导项,而用户不知道**。LM Studio 那个著名的「需要 22.92 GB」报错,实际是 **9B 模型开到 110k context**([#1631](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/1631),且实测只用了 ~11.5GB)。**任何不带 context 控件、只给模型标一个数字的 fit UI 都在撒谎**

**可复用资产** [CONFIRMED]:`sysinfo` 已是 perf 面板依赖(`src-tauri/src/perf/process.rs:14`),拿系统内存不必新增依赖。`MTLDevice.recommendedMaxWorkingSetSize` 需要新的 Metal 调用 [OPEN → §4-O3]。
**验收**:对同一模型改 context,fit 判定随之改变(这条测试本身就能防住「只给一个数字」的错误设计)。

#### W11 [P3] 向导用真实模型列表

**问题**:`add-provider-wizard.tsx:84` 的注释直白写着 `── Mock model lists per provider ──`,`:125` 硬编码 `llama3.2` 等 [CONFIRMED]。
**修法**:W1/W2 之后直接查 `/api/tags`。
**验收**:向导列出的模型 = 本机实装模型。

---

### P4 —— Apple Silicon 原生栈(macOS 的真正差异化)

**全部 [OPEN]** —— 见 §4-O4。以下是决策所需的事实,不是既定方案。

#### W12 [P4] MLX

**动机** [AGENT]:

- **Ollama 自己现在就跑在 MLX 上**([ollama.com/blog/mlx](https://ollama.com/blog/mlx),2026-03-30:_"Ollama on Apple silicon is now built on top of Apple's MLX"_)—— 这条**推翻了「MLX 是可选优化」的假设**
- M5 的 Neural Accelerators 让 **TTFT/prefill 快 3.33–4.06×**(Apple ML Research),但 token 生成只快 1.19–1.27×(前者 compute-bound 吃加速器,后者 memory-bandwidth-bound)
- 业界对标里 **6 个纯客户端应用零 MLX** —— Apple Silicon 上最大的单点缺口

**接入方式**:`mlx_lm.server` 确实存在且 OpenAI 兼容(默认 `127.0.0.1:8080`,支持按请求切模型、tool calling、结构化输出),**但官方明确警告 _"not recommended for production as it only implements basic security checks"_**。而且 **LM Studio 和 Ollama 都不 shell out 到它 —— 都是嵌库**(LM Studio 的 [mlx-engine](https://github.com/lmstudio-ai/mlx-engine) 是 MIT)。
**⚠️ 战略警告(证据驱动)**:**别打包推理引擎**。AnythingLLM 纯因「拖慢构建」就删掉了内置 llama.cpp([PR #3024](https://github.com/Mintplex-Labs/anything-llm/pull/3024));Cherry Studio 独立收敛到同一均衡(只打包 embedding/OCR 小模型,chat 委托 Ollama)。**最省的路径可能是:什么都不做 —— 用户装的 Ollama 已经在用 MLX 了。**

#### W13 [P4] Apple Foundation Models

**动机** [AGENT]:免费、零安装、零 RAM 占用的 provider。
**接入 Tauri 的现成路径**:[`remdalm/fm-bindings`](https://github.com/remdalm/fm-bindings) v0.1.5(2026-04-28,Apache-2.0/MIT,macOS 26+),`build.rs` 编译 Swift bridge、零拷贝 FFI 包 `LanguageModelSession`,支持阻塞/流式/取消。
**约束(会杀死一部分用例)**:

- **无 tool calling / 无 structured output**(fm-bindings 层面)
- context:macOS 26 ≈ **4,096 tokens**(Apple DTS 工程师确认);macOS 27 = 8,192
- 模型 ~3B
- 仍是 beta,预期 breaking changes
- **无 C/ObjC API** —— FoundationModels 是 Swift-only,任何路径最终都是 Swift shim

**⚠️ 必须实测的陷阱** [AGENT,且 agent 自标 UNVERIFIED]:`gety-ai/apple-on-device-openai` **刻意做成 GUI 而非 CLI**,因为 _"command-line tools encounter rate limits, though the GUI app reportedly avoids them"_。**若 Tauri sidecar 是 headless 二进制,可能撞上。这条与 Apple 文档矛盾(另有说法称设备端模型无请求限制),设计前必须实测。**
**⚠️ 已证伪,别踩**:广传的「Apple 出了 `fm serve` OpenAI 兼容 server」是**假的** —— Apple session 334 只列 `fm respond` / `fm chat` / `fm schema`,该博客未引用任何 Apple 来源。

---

### P5 —— 清理

#### W14 [P5] 死代码与重复事实源

全部 [AGENT],**这些是 pre-existing,按全局规则「flag 而非顺手删」,单独成 commit**:

- `built-in-provider-catalog.ts:2120+` 的本地 provider 条目被 INLINE 整体覆盖 → **死代码**,但会误导后续修改(memory 已记录此坑)
- baseURL 事实存在**三份**:`INLINE_PROVIDERS`、`LOCAL_PROVIDER_URLS`、`LOCAL_PROVIDER_CONFIGS`。解析器绕开 INLINE 直读 `LOCAL_PROVIDER_URLS`(`lib/ai/provider-consumption.ts:342-344`)—— **聊天因此可用,代价是三份真相**
- `components/settings/provider/ollama-model-manager.tsx` —— **孤儿组件**,仅 barrel 导出 + stories + test,从未被渲染(活的是 `LocalProviderModelManager`)
- `hooks/ai/use-ollama.ts:14` 的 `import { generateOllamaEmbedding as _ignored }` —— 纯无用导入
- `ollama.ts` 11 个导出中 **10 个零生产调用点**(仅 `generateOllamaEmbedding` 有真实调用方)
- `LOCAL_PROVIDER_PORTS`(`local-provider.ts:112`)—— 仅一处转发,无终端消费者
- `local-provider-settings.tsx:180-181,187` 的 `"Connected"` / `"Connection failed"` —— **硬编码英文,违反规则 4**(i18n 其余部分合格)

---

## 3. 业界对标速查

来源见 §6。**全部 [AGENT]**,选型前请自行复核。

### 3.1 三条推翻常识的纠正

1. **Ollama 现在自己跑在 MLX 上** —— 「要不要上 MLX」的问题因此变成「用户装的 Ollama 已经在用了,我们还需要自己接吗」
2. **`fm serve` 不存在** —— 广传博客无 Apple 来源
3. **AnythingLLM 早已删掉内置 llama.cpp**(2025-01,理由是拖慢构建),但**文档至今没改** —— **文档会撒谎,代码不会**

### 3.2 值得抄的四件事

| 能力            | 谁做得好                   | 关键点                                                                              |
| --------------- | -------------------------- | ----------------------------------------------------------------------------------- |
| 下载前 fit 判定 | Jan                        | 零字节下载即判定;6/10 应用完全不查内存 → 无人占领的高地                             |
| 真实能力探测    | AnythingLLM                | `/api/show` → `capabilities`(8 值)。Enchanted 更省:`/api/tags` → `details.families` |
| 后端生命周期    | LM Studio `llmster` / Msty | 自动装引擎 / 无头守护进程。多数应用只是假设 `:11434` 活着                           |
| 诚实的 pull UX  | Witsy(~60 行)              | 因为服务端根本无法取消 —— 所谓「取消」都是客户端幻觉,**知道自己在撒谎,并说出来**    |

### 3.3 fit 检查的三个时机(各自都不完整)

Jan = 下载前(零字节)· LM Studio = 加载前(按当前设置)· Ollama = 调度前(**不警告,直接让它装得下** —— 驱逐 / 降 context / 少 offload 层)。

---

## 4. 未决问题(**不要默默替它做决定**)

| 编号   | 问题                                                                                                                                                                                         |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **O1** | **W1 的 initializer 挂在哪?** 本仓有 desktop-only-initializers 的坑(见 memory `code-adoption-tracking-phase1`)。provider-core 的 adapters 在 web / Tauri / mobile 三个 shell 下应各注入什么? |
| **O2** | **W3 走哪条路?** 若 W5 同期做则 W3 作废;若 W5 延后则必须补 inert 标注。**取决于本计划的排期决定,不是技术决定。**                                                                             |
| **O3** | **fit 检查要不要引入 Metal 调用?** `MTLDevice.recommendedMaxWorkingSetSize` 是最准的预算来源,但会新增 Metal 依赖。退而求其次:`sysinfo` 总内存 × 67%/75% 经验系数(已有依赖,零新增)。          |
| **O4** | **P4 到底做不做?** 证据同时指向两个相反方向:MLX 是 Apple Silicon 最大缺口 **且** Ollama 已经替我们用上了 MLX;打包引擎有两个失败先例。**建议先不做,把 P0–P2 做扎实。**                        |
| **O5** | **要不要 ADR-0076?** 若只做 P0–P2(修复既有缺陷,无架构变更),可能不需要 ADR。P4 若上马则必须有。                                                                                               |

---

## 5. 验证与门禁

### 5.0 动手前:先坐实 CSP(**唯一的实机证据缺口**)

```bash
pnpm tauri build      # 或 pnpm build && pnpm tauri dev 复现打包 CSP —— dev 无 CSP,必须用打包构建
```

打开设置 → Providers → Ollama → 扫描,**看 WebView 控制台是否报 CSP 违规**。

- **若报** → §0.3 推导成立,按本计划执行
- **若不报** → W1/W2 仍正确(死 invoke 就是死 invoke),但优先级要重排,且 §1.2 的架构不对称结论需修正

### 5.1 每项完成后

```bash
pnpm test:changed
pnpm test:coverage:changed -- --strict      # ≥90%,注意 memory 记录的 coverage:changed 已知坑
pnpm typecheck                              # 基线已坏 —— 门禁是「无 NEW error」
pnpm lint:i18n                              # 基线容忍 487 条 legacy,新增会漏 → 配合 i18n-reviewer agent
cargo test -p cognia-net                    # 仅 W9
```

### 5.2 提交前

跑 `preflight` skill(六个审计 agent 并行):`test-gap` / `i18n` / `static-export` / `tauri-rust` / `pii-gate` / **`wiring`**。

**`wiring-auditor` 对本计划尤其重要** —— 本仓最反复出现的缺陷就是「造好了但没接线」,而本计划**整篇都在修这个**。W1 本身就是一次接线;别让修复变成新的休眠。

### 5.3 Changeset

W1–W11 均为用户可感知变更 → `pnpm changeset`(`cognia-next`,patch/minor)。W14 是内部清理 → 跳过。

---

## 6. 来源

**代码内证据**均为 [CONFIRMED],file:line 见正文。

**外部来源**(全部 [AGENT],研究 agent 提供,作者未独立复核):

- Ollama MLX:https://ollama.com/blog/mlx (2026-03-30)
- Ollama capabilities 枚举:`ollama/types/model/capability.go`(raw source)
- Ollama fit 公式:`PredictServerVRAM` in `llm/llama_server.go` ⚠️ 旧文档引用的 `EstimateGPULayers` in `llm/memory.go` **已不存在**
- pull 无法取消:https://github.com/ollama/ollama/issues/13142 (open)
- `/api/embed` vs `/api/embeddings`:https://docs.ollama.com/api/embed ⚠️ 广传的「自 v0.1.35 起」**是假的**,该版本 release notes 从未提及 embed;确切引入版本 **UNVERIFIED**
- LM Studio guardrails:https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/1631
- Jan fit 判定:https://www.jan.ai/docs/desktop/manage-models
- AnythingLLM 删除 llama.cpp:https://github.com/Mintplex-Labs/anything-llm/pull/3024
- Rust FM 绑定:https://github.com/remdalm/fm-bindings
- macOS 统一内存上限:https://github.com/ggml-org/llama.cpp/discussions/2182(`reservePercent = 33.333f`,>32GB 时降至 `25.0f`)⚠️ 用户可调键是 **`iogpu.wired_limit_mb`**,不是 `iogpu.wired_limit_max`;重启即失效

**研究 agent 自报的可靠性问题**:该 agent 在本次调研中纠正了自己 subagent 的一条错误结论(「Ollama 无 MLX」),并将三条广传说法判定为无来源。**这提示本主题的二手结论错误率很高 —— §3 与 P4 的任何选型主张,动手前都请回到 raw source。**
