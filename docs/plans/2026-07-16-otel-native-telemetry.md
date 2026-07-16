# OTel 原生埋点体系 — 实施计划

**日期**: 2026-07-16
**状态**: 已实施（2026-07-16）
**决策**: **直接采用 OpenTelemetry,不接入 Tea**
**范围**: 两阶段 —— P1 工程可观测(修通管道)、P2 用户行为事件层
**出口**: 统一经 Rust,同时支持本地/自建 collector 与 Grafana Cloud
**参考 ADR**: 0035(Rust 性能面板)、0067(crate 分解与编译提速 —— 见 R1)、0068(前端包抽取)、0022(Agent Team)、**0074**（0073 已被并发的 Chromium Cookie Import ADR 占用）

---

## 0. 如何使用本文档

每个工作项自成单元:问题 → 证据 → 修法 → 验收。除非标注 **依赖**,否则彼此独立,一项一个 commit。

### 0.1 置信标签 —— 动手前先读这节

沿用 `2026-07-15-tui-audit-remediation.md` 的约定。**标签不是装饰。**

| 标签            | 含义                                        | 你必须做什么                                   |
| --------------- | ------------------------------------------- | ---------------------------------------------- |
| **[CONFIRMED]** | 本文作者亲手 grep/读代码核实,file:line 已对 | 可信,但行号会漂 —— **按符号重新定位,别按行号** |
| **[AGENT]**     | 由 subagent 提供证据,作者未独立复核         | **动手前先自行复核这条具体主张**               |
| **[OPEN]**      | 真正未决,需要人来拍板                       | **不要默默替它做决定**,见 §8                   |

### 0.2 证据标准(不可妥协)

**本次调研最贵的一课:一次搜索返回的空结果,和真正的零匹配长得一模一样,但可能是假象。** 这个坑在本次会话里咬了两次:

1. `rg` 用 BRE 风格的 `\|` 转义会**静默返回空**(不报错)。作者据此一度断定 `trackInboxEvent` 无调用点 —— 实际有 **9 处**。
2. 一个 subagent 的结论 **"Production Call Sites: NONE — 基础设施就绪、等待接入"** 是**假的**。作者自行 grep 后发现 **5 个 surface 全部已接入**。若照它写计划,整份方案的重心会完全跑偏。

**因此:凡本文出现「零 / 不存在 / 未使用」的主张,均已跑阳性对照** —— 用同样形状的命令去搜一个已知存在的词,确认工具本身在工作,再采信那个零。你复核时请照做。

---

## 1. 研究结论(先读这节,它推翻了「埋点不存在」的默认假设)

第一直觉是「本仓没有埋点、覆盖不足」。**事实相反。**

**本仓没有产品分析意义上的埋点 SDK** [CONFIRMED] —— Tea / `byted-tea-sdk` / GA / Mixpanel / Amplitude / PostHog / Sentry / Segment 一个都没有;72 篇 ADR 里也无一篇谈遥测。这部分属实。

**但 agent/LLM 链路的埋点是建成的,而且 5 个 surface 全部在发 span** [CONFIRMED]:

| surface       | 发射点                                                                                                                            |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `chat`        | `hooks/chat/use-claude-chat.ts:1320`                                                                                              |
| `agent-team`  | `lib/ai/agent/team/dispatch-teammate.ts:530`、`lib/ai/agent/external/agent-trace-bridge.ts:75`                                    |
| `plugin-hook` | `lib/plugin/agent-sdk/tracing.ts:36`                                                                                              |
| `workflow`    | `lib/workflow/nodes/ai/ai-prompt-v2.ts:115`、`lib/workflow/nodes/actions/agent-turn.ts:75`、`lib/workflow/nodes/built-ins.ts:452` |
| `connector`   | `lib/connectors/ai-loop/safe-send-prompt.ts:186`(经 `recordProviderOutcome`)                                                      |

`packages/agent-trace/` 已具备 [CONFIRMED]:emitter(W3C 128/64-bit ID、`crypto.getRandomValues`)、`span-to-otlp.ts`(gen_ai.* semconv)、`chat-tool-spans.ts`(工具调用子 span,已在 `use-claude-chat.ts:2334` 接线)。
`lib/logging/transports/otlp-http-transport.ts` 已具备 [CONFIRMED]:批量/指数退避重试/PII 门禁/`captureContent` 开关。

> **所以本计划不是「补埋点」,而是「让已建成的埋点真的出得去、串得起来」。**
> 一句话总结缺口:**数据出不去(G1),链路是断的(G3/G4/G5),外加一个骗人的死开关(G2)。**

---

## 2. 缺口清单

### G1 — 桌面端 CSP 拦死全部远程出口 **[CONFIRMED] / Blocker**

`src-tauri/tauri.conf.json`:

```
connect-src 'self' ipc: http://ipc.localhost ws: wss:
```

无 `https:`,无任何外部 host;**连 `http://localhost:4318` 都不属于 `'self'`**。`tauri.macos.conf.json` 无 csp key(继承基线,已用 JSON 解析逐个确认,非 grep 猜测)。

renderer 走 `globalThis.fetch`(`otlp-http-transport.ts:99`),仓库无 `@tauri-apps/plugin-http`。
⇒ **OTLP / Langfuse / remote 三个远程 transport 在主力壳(Tauri 桌面)里全部不可达。**

`pnpm dev` 浏览器模式无 CSP,故开发期「看似可用」—— 这解释了为何没人发现。
`app/layout.tsx:1-3` 甚至留有注释提醒「调外部 API 要往 connect-src 加 origin」,但没人把它和遥测联系起来。

### G2 — `OtelTransport` 是结构性死代码 **[CONFIRMED] / 高(误导)**

全仓仅有 `@opentelemetry/api`(纯接口包),**无任何 SDK / TracerProvider**(已跑阳性对照)。无 provider 时 `trace.getActiveSpan()` 恒为 `undefined` ⇒ `packages/logging/src/transports/otel-transport.ts:137` 的 `if (!span) return` **每次都命中**。

且它自身**没有 exporter**;`endpoint` / `serviceName` 仅在 `OtelTransportOptions` 中声明,**实现从不读取**(全文件仅 2 处提及 `endpoint`,都在接口定义里)。

而 `components/logging/log-settings.tsx:1214` 渲染了**可编辑的 OTLP endpoint 输入框并预填 `http://localhost:4318`**。用户在里面填地址,什么都不会发生。

> 注意区分两个同名物:死的 `OtelTransport`(装饰外部 span,无出口)vs 真正的 `OtlpHttpTransport`(`lib/logging/transports/otlp-http-transport.ts`,受 `agentTraceOtlp` 控制,默认 `false`/preset `"off"`)。设置页并列两个 "OpenTelemetry" 正是困惑之源。

### G3 — Rust 全程不在链路中 **[CONFIRMED](依赖清单为 [AGENT])/ 高**

**任何 Rust Cargo.toml 中零 OTel crate** [CONFIRMED,已跑阳性对照:同命令能打到 `tracing = "0.1"`]。

现有(以下为 [AGENT],复核前勿依赖具体版本):`tracing 0.1` / `tracing-subscriber 0.3`(输出到 `cognia-structured.log`)、`dial9-tokio-telemetry 0.3`(本地二进制 flight recorder)、`crash-handler` + `minidumper`、perf sampler(`perf://sample`,仅面板打开时采样)。

`crates/cognia-instrument` 已有分桶直方图 [CONFIRMED]:`Histogram::record_micros` / `percentile_micros` / `buckets`、`MetricsRegistry::record/snapshot`、`#[timed]`/`#[guard]` 宏 —— **却从不导出**。这套东西可近乎 1:1 映射 OTLP Histogram data point,是 G6 的现成弹药。

### G4 — sidecar 全程不在链路中 **[CONFIRMED] / 高**

`experimental_telemetry` **全仓零使用** [CONFIRMED,已跑阳性对照:同命令能打到 `streamText`],而 `sidecar/package.json:26` 的 `ai: 6.0.208` **原生支持**它。sidecar 无 NodeSDK / exporter [AGENT]。

⇒ **真实 LLM 调用耗时完全不可见。** 目前仅靠 `sidecar/fetch-interceptor.mjs` 抓 ratelimit header、`result` 事件回传 token usage [AGENT]。

sidecar 是独立 Node 进程,**不受 CSP 约束**,且是 LLM 调用真正发生地 —— 时序最准,是最该有 span 的地方。

### G5 — 无跨进程上下文传播 **[CONFIRMED] / 高(前置)**

traceparent 不穿越 JS→Rust(invoke)与 JS→sidecar(stdout JSON-lines)边界。

现设计刻意**不用** AsyncLocalStorage(浏览器无此 API;且并发 turn —— agent-team 成员、多面板会话 —— 会串味),改为 `TraceContext` 显式传值(`types/agent-trace/trace-context.ts`)。这是合理决策,**保留**。

⇒ **G3/G4 若不先解决 G5,补出来的 span 全是孤儿,拼不成同一条 trace。**

### G6 — 仅 traces 一种信号 **[CONFIRMED] / 中**

无 metrics 导出(尽管 `cognia-instrument` 已有直方图)、无 logs 导出。

### G7 — traceId 未穿透即静默跳过 **[CONFIRMED] / 中**

`lib/claude/provider-telemetry.ts:178`:

```ts
if (outcome.traceId && sessionId) {
```

注释自认「Skipped when the caller did not thread a `traceId` (older sites)」。**无 warn、无计数 —— 静默丢。**

### G8 — 凭据明文入 localStorage **[CONFIRMED] / 高(见顺序约束)**

`lib/logging/bootstrap.ts:559-560` 把**整个** `transports` 对象 `JSON.stringify` 落 localStorage:

```ts
localStorage.setItem(LOGGING_CONFIG_STORAGE_KEY, JSON.stringify(getPersistedConfig(config)))
localStorage.setItem(LOGGING_TRANSPORTS_STORAGE_KEY, JSON.stringify(transports)) // ← 未经过滤
```

注意 `getPersistedConfig(config)` 对 _config_ 做了过滤,但 **`transports` 是原样落盘**。而该对象含 `langfuseConfig.secretKey`(:93)与 `agentTraceOtlpConfig.grafanaCloud.apiToken`(:114)。

仓库明明有 Rust `secret_store` 约定(`src-tauri/src/companion_api/secret.rs`、`push_creds.rs`、`mcp_oauth.rs`)在管其他凭据,此处未用。

### G9 — 开关语义倒置 **[CONFIRMED] / 中**

`bootstrap.ts:71-78`:`console`/`indexedDB`/`native`/`remote`/`langfuse`/`opentelemetry`/`agentTrace` **默认全 `true`**,靠 endpoint/凭据为空兜底,而非真开关(`remote` 有双重门 `transports.remote && config.remoteEndpoint`,`langfuse`/`opentelemetry` 只有单门)。

当前无害(`langfuse-client.ts:125` 无凭据即 no-op;`otlp-http-transport.ts:128` 无 endpoint 即丢弃),**但行为数据(P2)绝不可沿用此模式**。

### G10 — `a2ui.downgrade` 事件零 emit **[CONFIRMED] / 低**

`lib/db/inbox-telemetry-types.ts:39` 声明了该 kind,文档注释(:24)宣称由 `a2ui-bridge/a2ui-to-segments` 在降级到 `plainTextMirror` 时触发,且有测试覆盖 —— 但 `lib/connectors/a2ui-bridge/a2ui-to-segments.ts` **未 import 任何 telemetry 模块**。

「文档说它工作、实际不工作」,违反 Working Rule 7(三轴标注休眠)。

---

### ⚠️ 顺序约束(务必先读)

> **G8 与 G1 必须在同一个 PR 中修复,不可拆分先后。**
>
> 当前凭据明文存 localStorage 之所以**尚未造成实害,纯粹因为 CSP 把请求拦死了(G1)**。
> 一旦 P1 打通出口,这个潜伏的凭据暴露立刻被激活。
>
> **先修 G1 再修 G8 = 亲手开一个洞。**

---

## 3. Phase 1 — 工程可观测(修通管道)

### P1.0 先立红线(先看到红,再修绿)

把「桌面端发不出数」变成可复现的失败用例:

1. 起本地 collector:`docker run -p 4318:4318 otel/opentelemetry-collector`(或 `nc -l 4318` 看有无连接)。
2. `pnpm tauri dev` → 设置页 preset=self-hosted、endpoint=`http://localhost:4318/v1/traces` → 发起一次 chat。
3. **预期(修复前)**:collector **零请求**;WebView 控制台出现 CSP violation。
4. **对照**:`pnpm dev` 浏览器模式同样配置 → collector **收到 span**。

> 对照组证明 transport 本身是好的、坏的是壳 —— 这一步同时是 P1 的验收基线。

### P1.1 + P1.2 Rust 出口 + 凭据迁移(**同一 PR**,解 G1 + G8)

**核心洞察:改动可以极小。** `OtlpHttpTransport` 已有 `fetchImpl` 注入缝(`otlp-http-transport.ts:53`,原为测试预留)[CONFIRMED]。只需在 Tauri 环境注入一个走 IPC 的 shim,**transport 主体一行不用改**。

- **Rust 侧** 新增 `telemetry` 模块(建议 `crates/cognia-core` 或 `src-tauri/src/telemetry/`):

  ```rust
  #[tauri::command]
  async fn telemetry_otlp_export(
      endpoint: String,
      body: String,                       // 已由 TS 侧 spansToOtlp 序列化
      headers: HashMap<String, String>,   // 不含密钥,见下
  ) -> Result<TelemetryExportResult, String>
  ```

  用已在 `src-tauri/Cargo.toml:217` 的 `reqwest 0.12`(json feature)[CONFIRMED] —— **无需新 HTTP 栈**。Rust 不受 CSP/CORS 约束,这是绕开 G1 的根因解法。

- **凭据永不过 IPC**:`Authorization` header 由 **Rust 侧**从 `secret_store` 取出注入,前端只传 endpoint 与非敏感 header。
  - 迁移 `grafanaCloud.apiToken`、`langfuseConfig.secretKey` → keyring;读取旧值时**一次性迁移 + 主动擦除** localStorage。
  - `LoggingTransportSettings` 上将这两个字段改为只写引用式(如 `apiTokenRef: boolean`),**从类型层面杜绝回退**。
- **前端**:`lib/logging/transports/tauri-fetch-shim.ts`,`isTauri()` 时作为 `fetchImpl` 注入;浏览器/移动端保持原生 fetch(移动端无 CSP meta,且 CapacitorHttp 走原生栈 [AGENT,复核 `mobile/capacitor.config.ts`])。
- 注册 command + capability/ACL 条目(仓库硬要求)。

**验收**:P1.0 红线转绿 —— `pnpm tauri dev` 下 collector 收到 span;keychain 出现条目;localStorage 中 `apiToken`/`secretKey` 消失。

**为何不选其他方案**:

- ❌ 往 `connect-src` 加 `https:` —— 通配削弱全局 CSP;且**用户 endpoint 是运行时值,CSP 是构建期静态值,根本表达不了**。
- ❌ 引入 `@tauri-apps/plugin-http` —— 可行(其请求在 Rust 侧发出,天然绕过 CSP),但只解决 HTTP 转发,无法顺带承载 G3 的 Rust span 合流;且多一个插件依赖。自建 command 复用度更高。

### P1.3 删除死的 `OtelTransport`(解 G2)

**决策:删除,不保留。**

理由:它与 `agentTraceOtlp` 语义重叠,设置页并列两个 "OpenTelemetry" 已在误导用户;其 `endpoint` 字段是**骗人的**(可填、不生效)。按 Working Rule 7,「文档说它工作、实际不工作」正是必须消除的形态;若要保留则需三轴标注 dormancy —— 为一个无 exporter 的空壳付这个代价不值。

- 删:`packages/logging/src/transports/otel-transport.ts` + barrel 导出(`transports/index.ts:26-31`)+ `bootstrap.ts:662-672` 分支 + `opentelemetry`/`opentelemetryConfig` 设置项 + `log-settings.tsx` 对应 section(:1214-1258)+ i18n keys(en/zh-CN **双删**)。
- localStorage 中历史 `opentelemetryConfig` 平滑丢弃(读取时忽略未知键,勿抛)。
- **保留** `@opentelemetry/api` 依赖 —— P1.5 sidecar 侧会真正用到。

**验收**:`rg "opentelemetryConfig|OtelTransport"` 无生产残留;设置页仅存一个 OTLP 入口;`pnpm lint:i18n` 通过。

### P1.4 traceparent 跨进程传播(解 G5)

> **依赖**:无。**但 P1.5 / P1.6 依赖本项** —— 必须先行,否则补出的 span 是孤儿。

- 采用 W3C `traceparent`(`00-{traceId}-{spanId}-{flags}`),复用现有 `TraceContext`,**不引入 AsyncLocalStorage**(维持现有显式传值的设计理由:并发 turn 隔离)。
- renderer → Rust:凡需归因的 invoke 增加可选 `traceparent` 参数。
- renderer → sidecar:stdout JSON-lines 协议的 `sendOptions` 增加 `traceparent` 字段;`sidecar/dispatch/index.mjs` 入口透传给 anthropic / ai-sdk 两条路径 [AGENT,复核入口行号]。

**验收**:一条 trace 内同时出现 renderer/Rust/sidecar 的 span,且 parent 关系在 Tempo/Jaeger 瀑布图上正确嵌套。

### P1.5 sidecar 进链路(解 G4)

> **依赖**:P1.4

- **ai-sdk 路径**(`sidecar/dispatch/ai-sdk.mjs`,`streamText`):开启
  ```js
  experimental_telemetry: { isEnabled: true, functionId, metadata: { sessionId, traceId } }
  ```
  AI SDK 6.0.208 原生支持,**零额外 SDK 改造**。
- 装 NodeSDK + OTLPTraceExporter:新增 `@opentelemetry/sdk-node`、`@opentelemetry/exporter-trace-otlp-http` 到 `sidecar/package.json`;`@opentelemetry/api` 目前仅经 `ai` 传递获得 [CONFIRMED:sidecar/package.json 无直接依赖],应**提为直接依赖**以免版本漂移。
- **anthropic 路径**(`sidecar/dispatch/anthropic.mjs`,`claude-agent-sdk`):不支持 `experimental_telemetry` → 手写 span,复用 `fetch-interceptor.mjs` 这一**已有拦截点**计时(它已在抓 ratelimit header,是天然的 span 边界)。
- OTLP 配置经启动参数/env 下发;**凭据经 stdin/env,绝不走 argv**(见 R5)。

**验收**:真实 LLM 调用耗时出现在瀑布图,且挂在 renderer 根 span 之下。

### P1.6 Rust 进链路(解 G3,顺带 G6 第一版)

> **依赖**:P1.4

- 引入 `opentelemetry` + `opentelemetry-otlp` + `tracing-opentelemetry`,桥接已有 `tracing` 生态。
  **为何不手写**:手写第二套 semconv 会与 TS 侧 `span-to-otlp.ts` 形成双份技术债并必然漂移(见 R6)。
- **风险 R1(编译时长)**:ADR-0067 刚做完 crate 分解与编译提速,OTel crate 生态较重 → **必须 feature gate**(如 `--features otel-export`),默认关闭,不拖累日常 `cargo build`。
- `MetricsRegistry::snapshot()` 已是分桶直方图 → 近乎 1:1 映射 OTLP Histogram data point,顺带交付 G6 的 metrics 信号第一版。

**验收**:`#[timed]` 标注的 Rust 操作出现在 collector;**关闭 feature 后编译时长回到基线**(需实测对比,别凭感觉)。

### P1.7 收尾(G7 + G10)

- **G7**:审计所有 `recordProviderOutcome` 调用点确保 traceId 穿透;为「有 sessionId 但无 traceId」加 dev-mode warn + 计数器。
  > **修掉「静默」比修掉「丢失」更重要** —— 丢失可以接受,不知道自己在丢不行。
- **G10**:在 `a2ui-to-segments.ts` 降级到 `plainTextMirror` 处补 `trackInboxEvent("a2ui.downgrade", { adapterId, fields: { platform, reason } })`,兑现类型文档的承诺。

---

## 4. Phase 2 — 用户行为事件层

> **前提**:P1 已交付,管道确认可出数。**不要在管道未验证前建事件层。**

### P2.1 事件模型选型

OTel 无「产品分析事件」一等公民。三选一:

| 方案                                              | 评价                                                                                                                                                              |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **(a) OTel Logs signal(LogRecord)+ `event.name`** | **推荐**。语义最贴,是 OTel 官方对 events 的收敛方向;每事件一条 LogRecord,业务字段入 attributes。需新增 `/v1/logs` 出口 —— **复用 P1.1 的 Rust command,仅换 path** |
| (b) span events / 独立 span                       | 行为事件多为瞬时点,套 span 语义别扭,且会污染 trace 瀑布图                                                                                                         |
| (c) metrics counter                               | 丢失单事件维度,无法做漏斗/路径分析                                                                                                                                |

### P2.2 事件注册表(防止拍脑袋命名)

- 集中式 TS 类型化 catalog(对标 Tea 事件表),**编译期**校验事件名与参数 —— 这是 Tea 体系里最有价值的部分,值得独立保留。
- 命名规范:`<domain>.<object>.<action>`(如 `chat.message.sent`)。
- 配套 lint:未注册事件名不得调用。

### P2.3 埋点 API

- `trackEvent(name, attrs)`,类型受 P2.2 catalog 约束。
- **必须复用现有 PII 门禁** `packages/redact/src/index.ts:hasNoLeakingPii`(项目硬约定的出网前闸门)。
- 落 Dexie(本地看板)+ 经 P2.1 出口(远端),两路独立 —— 与现有 agent-trace 的双 transport 模式一致(Dexie 与 OTLP 互不依赖)。

### P2.4 隐私与开关(**不可沿用 G9 模式**)

- 行为数据必须**显式 opt-in**,默认 `false`,**真开关** —— 绝不沿用「flag 默认 true + 空 endpoint 兜底」。
- 与工程 trace 的开关**分离**:用户可能愿意上报崩溃/性能,却不愿上报行为。
- 首次开启需明确告知采集内容,并提供本地导出与清除。

---

## 5. 横切硬要求(每个 PR 都适用)

- **测试**:`components/**`、`hooks/**`、`lib/**`、`src-tauri/src/**` 新文件必须 co-located test;覆盖率 ≥90%。用 `pnpm test:coverage:changed -- --strict`(**全量 `coverage:changed` 在本仓有 glob 上限缺陷**)。
- **i18n**:`.tsx` 无硬编码用户可见串;新 key 双写 `i18n/messages/{en,zh-CN}/<ns>.json` 后 `pnpm i18n:build`;`pnpm lint:i18n` 校验。
- **changeset**:P1.1 / P1.3 / P2 均为用户可感知变更 → `pnpm changeset` 选 `cognia-next`。
- **Rust**:新 command 必须注册 + capability/ACL 条目;in-file `#[cfg(test)]`。
- **Dexie**:P2 若新增表,用 `nextSchemaVersion`(**勿 `db.verno+1`**)。
- **静态导出**:`app/api/` 生产不存在 —— 任何需要服务端的能力必须落 Rust(axum),不得加 Next 路由。

---

## 6. 风险登记

| #      | 风险                                         | 缓解                                                                   |
| ------ | -------------------------------------------- | ---------------------------------------------------------------------- |
| **R1** | OTel Rust crate 拖慢编译(ADR-0067 刚提速)    | feature gate 默认关;CI 单独 job;**实测编译时长对比,不凭感觉**          |
| **R2** | 放宽 CSP 削弱全局安全                        | **不采用**;走 Rust 出口(P1.1)                                          |
| **R3** | 打通出口即激活凭据暴露(G8)                   | **P1.1 与 P1.2 同 PR,不可拆**(见 §2 顺序约束)                          |
| **R4** | 行为事件 + LLM 内容使 PII 面扩大             | 强制 `hasNoLeakingPii`;`captureContent` 默认 false 不变;P2 独立 opt-in |
| **R5** | sidecar 凭据经命令行泄漏(`ps` 可见)          | 经 stdin/env 下发,**不走 argv**                                        |
| **R6** | 双 semconv(TS `span-to-otlp.ts` 与 Rust)漂移 | Rust 用官方 crate 而非手写;**跨端 golden test 对齐属性名**             |

---

## 7. 交付顺序

```
P1.0 立红线(验证 CSP 拦截)              ← 先看到红
  ↓
P1.1 + P1.2  Rust 出口 + 凭据迁 keyring   ← 同一 PR,解 G1+G8
  ↓                                        此后桌面端首次真正出数 ★
P1.3 删死的 OtelTransport(G2)            ← 独立小 PR,清理误导
  ↓
P1.4 traceparent 跨进程传播(G5)          ← G3/G4 前置,必须先行
  ↓
P1.5 sidecar(G4)   ┐
P1.6 Rust(G3+G6)  ┘                      ← 可并行,均依赖 P1.4
  ↓
P1.7 G7 + G10 收尾
  ═══ P1 验收:一条 trace 贯穿 renderer → Rust → sidecar ═══
  ↓
P2.1 → P2.4 行为事件层
```

**★ 最小可验证里程碑**:P1.1+P1.2 落地即可在 `pnpm tauri dev` 下让本地 collector 收到**第一条真实 span**。这是整个计划从「纸面」变「有数」的分水岭,也是决定后续投入是否值得的检验点 —— **若此处受阻,先停下重估,不要继续往下堆。**

---

## 8. 已拍板

1. ADR 同时提供英文与中文版；因 0073 被并发 ADR 占用，安全顺延为 **0074**。
2. P1.6 `otel-export` feature 在开发态与生产态均默认关闭，按需显式开启。
3. P2 事件 catalog 由仓库维护者共同把关，并通过 `CODEOWNERS` 固化评审责任。
