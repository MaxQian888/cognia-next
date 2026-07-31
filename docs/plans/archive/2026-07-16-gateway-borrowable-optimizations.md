# 内置网关 — 借鉴 newapi / sub2api 的优化计划

**日期**: 2026-07-16
**状态**: 待评审(未实施 —— 下文每一项都已对照 cognia 现有代码核实过"到底缺没缺",不是设想)
**范围**: 三波 —— W1 热路径缺口(直接改善"少量上游账号扛高频长上下文")、W2 订阅 OAuth 上游(踩 ToS,需拍板)、W3 工程增强;W4 明确列出**不借**的部分
**参考**: ADR-0043(LLM provider execution,§Phase 8 已借过一轮 newapi/one-api)、newapi(`QuantumNous/new-api`)、sub2api(`Wei-Shaw/sub2api`);相关 memory `gateway-borrowable-features-newapi-sub2api`

---

## 0. 如何使用本文档

每个工作项自成单元:**问题 → 证据 → 修法 → 验收**。除非标注 **依赖**,否则彼此独立,一项一个 commit。

### 0.1 本文档最重要的事:去重

用户的原始要求是"**再次确认每个优化点不重复**"。cognia 网关是 **"薄 Rust 执行层 + 富 TS 路由大脑"** 两层架构,很多 newapi/sub2api 的招牌功能已在 `packages/provider-*` 里实现。**本文每一条都已逐一 read/grep 核对过 cognia 是否已有等价物**,复核结果直接写进每项的「证据」里。两条原以为是"新建缺口"的,复核后发现 cognia **已建但休眠 / 部分实现**,已相应改写(见 W1.1、W1.3)—— 这正是本仓最常见的 built-but-dormant 缺陷,盲目重造只会加重它。

### 0.2 置信标签

沿用 `2026-07-16-scheduler-subsystem-remediation.md` 的约定。

| 标签            | 含义                                       | 你必须做什么                                   |
| --------------- | ------------------------------------------ | ---------------------------------------------- |
| **[CONFIRMED]** | 本文作者亲手 read/grep 核实,file:line 已对 | 可信,但行号会漂 —— **按符号重新定位,别按行号** |
| **[OPEN]**      | 真正未决,需要人拍板                        | **不要默默替它做决定**,见 §5                   |

本文所有「缺口/已有/休眠」判断均为 **[CONFIRMED]**(作者一手核实)。凡出现「零调用者 / 从不 / 不解析」的主张,均跑过阳性对照(用同形状命令搜一个已知存在的兄弟符号确认工具在工作)。

### 0.3 项目硬规矩(动手前先读 CLAUDE.md)

- **Rust 改动**:`#[cfg(test)] mod tests` 就地测试;coverage ≥90%;`crates/cognia-gateway` 属 workspace,`rtk cargo test -p cognia-gateway`。
- **TS 改动**:co-located `*.test.ts`;`packages/provider-*` 各有自己的测试。
- **无 UI 字符串硬编码**:若新增 Settings 开关(W2、W3.4),`i18n/messages/{en,zh-CN}` 双写 + `pnpm lint:i18n`。
- **changeset**:用户可感知的行为变化跑 `pnpm changeset`(选 `cognia-next`)。W1/W2 是,W3.2 内部安全默认可视情况。
- **parking_lot guard 不跨 `.await`**(见 `tauri-rust-reviewer`)—— W1.1/W1.2 的冷却/信号量结构注意锁作用域。

---

## 1. cognia 网关现状(对照基线 —— 别重复造)

**Rust 执行层** `crates/cognia-gateway/src/`:

- `server.rs` — axum 路由(`/v1/models`、`/v1/chat/completions`、`/v1/messages`、`/v1/embeddings`、`/v1/responses`、`/healthz`)、安全中间件(loopback/LAN Host 校验、Origin/Referer 拒绝、IPv4 CIDR 白名单、常量时间 key 校验)、全局+按 key 固定窗口限流、token 配额门(`server.rs:357` `over_quota`)、流式/非流式 usage 嗅探扣配额。
- `execute.rs` — 候选解析(alias / `provider:model` / 裸模型)+ **池内多 key 轮询**(`ProviderKeyRotation`,`execute.rs:26-32`,round-robin/random/least-used)。
- `keyed_rate_limit.rs` — 按 key 每分钟固定窗口。
- `translate/` — OpenAI/Anthropic/Responses/embeddings 互转;`errors.rs` 按入站格式重塑错误。
- `api_keys.rs` — keyring 多 scoped key(模型白名单、过期、限流、token 配额)。

**TS 路由大脑** `packages/provider-*`:

- `provider-routing` — `ProviderRoutingEngine.selectProvider`、6 种策略(quality/cost/speed/balanced/adaptive/least-busy)、**filter 链**(含 `filters/affinity.ts` 会话亲和、deployment-filter 健康/预算/限流门)。
- `provider-core` — `model-pricing`(input/output + `cachedInputPer1M`/`cacheCreationPer1M`)、`circuit-breaker-machine`(closed→open→half-open,**已支持 Retry-After → dynamic cooldown**)、`health-metrics-collector`(p50/p95、成功率滑窗)、`api-key-rotation`。

**网关接线**:`lib/gateway/snapshot-publisher.ts`(把 provider + alias 打包成快照推给 Rust;`enrichSnapshotWithSubscriptionCreds:226` 能把订阅金库凭证当 **API key** 上游)、`lib/gateway/decide.ts`(live 路由决策)、`lib/gateway/telemetry-forwarder.ts`(把 `gateway://request-outcome` 喂回健康/熔断/成本 store)、请求日志 Dexie v99 `gatewayRequestLog`。

**已具备、不要重造的清单**:

| 能力                             | 已在哪                                                 |
| -------------------------------- | ------------------------------------------------------ |
| 多 provider 抽象 + 协议翻译      | Rust `translate/`                                      |
| 6 种路由策略 / 加权选路          | `provider-routing`                                     |
| 熔断 + 健康度滑窗                | `circuit-breaker-machine` / `health-metrics-collector` |
| 按模型定价(含缓存分档)           | `model-pricing`                                        |
| 多 key 池轮询                    | `execute.rs`                                           |
| 失败走链 failover + 可配重试码   | Rust `types.rs:should_retry`                           |
| 按 key 配额/限流/模型白名单/过期 | `api_keys.rs` / `keyed_rate_limit.rs`                  |
| 持久请求日志 + Logs UI           | Dexie v99 + Settings                                   |
| 错误按入站格式重塑               | `translate/errors.rs`                                  |
| 订阅→网关上游(API key 形态)      | `enrichSnapshotWithSubscriptionCreds`                  |

---

## 2. W1 — 热路径缺口(P0,纯进程内,不碰 ToS)

> 主题:cognia 网关面向的头号客户端是 Claude Code CLI / Codex,它们天然**高频、长上下文、重复上下文**。W1 三项直接改善"用用户自己有限的几个上游账号/订阅稳定扛住这种流量",且互相配合。

### W1.1 — 池内 key 的跨请求"账号级冷却" + 解析上游限流头 **[CONFIRMED]**

**问题**:某个池内 key 被上游 429/529,下次请求还会再选它,白白消耗 failover 预算,并加速触发上游风控。网关也完全不利用上游返回的"何时恢复"信息。

**证据**(已对照 cognia,确认是真缺口):

- Rust 池轮询状态只有 `last_index` + `use_counts`,**没有任何 per-key 冷却/backoff 时间戳** —— `execute.rs:26-32`(`ProviderKeyRotation`)、`expand_key_pools:75` 只按策略排序后原样展开,不跳过"刚失败"的 key。
- 网关**不解析** `Retry-After` / `anthropic-ratelimit-unified-reset` / `x-codex-*` 等头(阳性对照:`grep -rn "retry.after|ratelimit" crates/cognia-gateway/src` 仅命中 `keyed_rate_limit.rs` 的自有限流,无响应头解析)。
- **注意别重造**:TS 熔断器**已经**支持 Retry-After → dynamic cooldown(`circuit-breaker-machine.ts:11,27` `RecordFailureOptions{retryAfterMs}` → `clampDynamicCooldown`)。但 (a) 它是 **provider 粒度**,不是池内单 key;(b) 网关 outcome 转发只带 latency/token,**不带 retryAfterMs**(`telemetry-forwarder.ts:23-33`),所以那条 dynamic-cooldown 路径**从没被喂过数据**;(c) 它在 renderer 侧,只影响下一次快照/决策,不在 Rust 热路径拦截。

**修法**(借 sub2api `ratelimit_service.go` 的分错误码冷却,落在 Rust 热路径):

1. `execute.rs` 新增 `KeyCooldownMap`:`Mutex<HashMap<(provider_id, key), cooldown_until_ms>>`,挂在 `GatewayState` 上(与 `KeyRotationMap` 并列)。`expand_key_pools` 展开时**跳过**仍在冷却窗内的 key;若整池都在冷却,退回"最早恢复的那个"(避免全灭时 500)。
2. 上游响应后解析头 → 冷却时长:429 读 `retry-after`(秒)或 Anthropic `anthropic-ratelimit-unified-reset`(epoch);429 无可解析头 → 一个**可配的小冷却**(默认如 20s,可关,借 sub2api `apply429FallbackRateLimit` 的思路);529 → 固定 `overload_cooldown`(默认 10min)。冷却时长写进 `GatewayConfig`(camelCase,和 `types/gateway/index.ts` 对齐)。
3. **顺带补齐已有休眠路径**:在 `telemetry-forwarder.ts` / gateway outcome 里带上从头解析出的 `retryAfterMs`,让 TS 熔断器那条 dynamic-cooldown 终于有数据 —— 一改两得。

**验收**:

- `execute.rs` 就地测试:构造一个"key-b 冷却中"的 map,断言 `expand_key_pools` 跳过 b、只展开 a/c;全池冷却时回退到最早恢复者;冷却过期后 b 重新可选。
- 头解析单测:`retry-after: 30` → 30_000ms;`anthropic-ratelimit-unified-reset: <epoch>` → 正确差值;无头 → fallback 值;非 429 → 无冷却。
- `rtk cargo test -p cognia-gateway`;coverage ≥90%。

**依赖**:无。是 W1.2 / W3.1 的基础。

---

### W1.2 — 并发上限(in-flight cap)per 网关 key / per 池内 key **[CONFIRMED]**

**问题**:网关只有"每分钟固定窗口"限流,**没有并发数控制**。一个客户端可瞬间并发打满上游账号,触发风控。

**证据**:

- 限流只有 `keyed_rate_limit.rs`(固定窗口计数)+ 全局 `FixedWindowRateLimiter`,**无信号量/并发计数**(阳性对照:`grep -rn "semaphore|concurren|in_flight" crates/cognia-gateway/src` 全空)。
- **注意别重造**:`least-busy` 策略确实读 in-flight(`built-in.ts:135` `telemetry.getInFlight`),但 (a) 那是**软选路信号**(选最闲的),**不是 cap**,不会 reject/queue;(b) 默认 runtime adapter 的 `getInFlight: () => 0` 是**桩**(`runtime-adapters.ts:118`),阳性对照确认无生产写入器 —— 即 in-flight 追踪本身也基本休眠。所以"并发上限"是真缺口,和 least-busy 不冲突。

**修法**(借 sub2api 并发槽概念,单进程用 `tokio::Semaphore`,不用 Redis):

1. `GatewayConfig` 加 `maxConcurrentPerKey`(默认 0 = 不限)、可选 `maxConcurrentPerUpstreamKey`。
2. 每个网关 API key(和/或每个池内上游 key)一个 `Arc<Semaphore>`;请求进入时 `try_acquire`,拿不到 → 要么 429 `concurrency_limit`(默认),要么带超时排队(可配,借 sub2api `AccountWaitPlan` 的 timeout+max-waiting 思路,先做简单版:直接 429)。
3. 持有的 permit 在请求(含流式)结束时释放 —— **务必用 RAII guard**,别在 `.await` 边界丢锁(见 tauri-rust-reviewer)。

**验收**:

- 就地测试:`maxConcurrentPerKey=2`,并发 3 个请求,第 3 个立即拿到 429;释放一个后第 4 个能进。
- 流式请求结束(正常/断流/错误)都释放 permit 的测试。
- `rtk cargo test -p cognia-gateway`。

**依赖**:无(可与 W1.1 并行)。

---

### W1.3 — 激活休眠的会话亲和,并让网关按 prompt-cache 块做亲和键 **[CONFIRMED]**

**问题**:同一轮对话的连续请求可能被路由到不同上游 provider/账号,浪费 Anthropic/OpenAI 的 prompt-cache(cache-read 折扣),对 Claude Code 这类长上下文客户端损失显著。

**证据**(这是本次去重最关键的一条 —— 不是"新建",而是"激活 + 扩展"):

- cognia **已完整实现 LiteLLM 式会话亲和**:filter `packages/provider-routing/src/filters/affinity.ts:25`、store `session-affinity-store.ts`(`pinSessionDeployment`/`getSessionDeployment`/`releaseSessionDeployment` + TTL)、engine 会报 `Session pinned to X (affinity)`(`provider-routing-engine.ts:325`)。
- **但它是 built-but-dormant**:写入器 `pinSessionDeployment` **在生产代码里零调用**(`session-affinity-store.ts:24`;阳性对照:同文件的兄弟 `getSessionDeployment` 被 `build-preview-engine.ts:104` 真实引用,证明 grep 工具在工作,而 `pinSessionDeployment` 只有 `*.test.ts` 命中)。→ 从没有会话被 pin,亲和 filter 对 **chat 和 gateway 都是永久 no-op**。
- **网关路径更断一截**:`decide.ts:33` 调 `engine.selectProvider({model, promptText, estimatedInputTokens})` —— **不传 sessionId**;而 chat 路径 `build-options.ts:1117` 是传了 `sessionId: session?.id` 的(只是没人 pin 所以也没用)。

**修法**(先激活现成机制,再借 sub2api 的"按 cache 块做键"的洞见):

1. **激活写入**:在成功一轮后调 `pinSessionDeployment(sessionId, deploymentKey)`。
   - chat 路径:在 `lib/claude/provider-telemetry.ts` 记 success outcome 处一并 pin。
   - gateway 路径:在 `decide.ts` 决策成功 / gateway outcome 成功回流处 pin。
2. **网关派发 sessionId,并按 sub2api 的方式取键**:改 `decide.ts` 的 `GatewayDecideRequest` 带 `sessionId`,来源优先级(借 sub2api `GenerateSessionHash`):
   - (a) Anthropic `metadata.user_id` 里的 session_id(Claude Code 原生信号);
   - (b) 否则 hash **第一个 `cache_control:{type:"ephemeral"}` 的 content block** —— 妙处:Anthropic 自己的 prompt cache 就按这个内容 key,亲和键与上游缓存键**天然对齐**,stickiness 直接换成 cache-read 折扣;
   - (c) 否则退回 `client-ip + UA + apiKeyId + system 摘要` 的 hash。
   - 该派生逻辑放在 Rust 网关(请求解析处)算出 sessionId,再随 `gateway://decide` 传给 `decide.ts`;纯函数、可单测。
3. 亲和 filter 已自带"pin 的 deployment 熔断/冷却时释放"(`deployment-filter.ts:69` `releaseSessionDeployment`),W1.1 的 key 冷却与之协同 —— 冷却中的账号会被亲和自动放弃。

**验收**:

- `session-affinity-store` 已有测试;新增"成功后 pin 被写入"的集成测试(provider-telemetry / gateway outcome)。
- sessionId 派生纯函数单测:有 `metadata.user_id` → 用之;有 ephemeral cache block → hash 稳定且同内容同键;都无 → fallback 键。
- `decide.ts` 单测:传 sessionId 且 store 有 pin → 候选链把 pin 排到最前(`affinityPinned` note 出现)。

**依赖**:与 W1.1 协同(冷却→释放亲和),但可独立实现。

---

## 3. W2 — 订阅 OAuth 账号作为网关上游 + 原生客户端拟真 **[OPEN]**

> 这是 sub2api 真正独有、也最贴合"内置网关"主题的能力,但明确游走在上游 ToS 边缘。**是否做、以什么默认姿态做,需用户拍板(见 §5)。** 下面只给技术方案,不预设决定。

**问题 / 现状**:cognia 已有 Claude 订阅 OAuth(sidecar 读 `CLAUDE_CODE_OAUTH_TOKEN`、memory `anthropic-subscription-local-reuse`),其**自身 chat** 走 Claude Agent SDK,SDK 内部带全套 CLI 头。但:

- 网关能接的订阅只是**"订阅换 API key"**(`enrichSnapshotWithSubscriptionCreds` 解析成 `{apiKey, baseURL}`),**不能**直接拿 **OAuth bearer** 打 `api.anthropic.com/v1/messages`。
- Rust 网关上游鉴权**只有 `x-api-key`**(`execute.rs:223-238` `upstream_headers`,Anthropic 分支只塞 `x-api-key` + `anthropic-version`),**无 OAuth bearer 路径,无 CLI beta 头集,无 `cc_version` 指纹**(阳性对照:`grep -rn "anthropic-beta|claude-cli|cc_version" crates/cognia-gateway` 全空;sidecar 的 `anthropic.mjs:308` 只是 computer-use 的 beta 透传,非计费头集)。

**修法**(借 sub2api 拟真栈,**仅当用户开启**):

1. `ProviderSnapshot` 加 `authKind: "api_key" | "oauth_bearer"`;`upstream_headers` 对 `oauth_bearer` 走 `authorization: Bearer <token>` + Anthropic 的 OAuth beta 头。
2. OAuth token 按需刷新:复用 cognia 现有订阅金库 + 刷新逻辑(单进程 `tokio::Mutex` 防并发刷新,替代 sub2api 的分布式锁)。
3. **拟真头**(借 `pkg/claude/constants.go` + `metadata_userid.go`):完整 `anthropic-beta` CLI 集、`User-Agent: claude-cli/…`、`X-Stainless-*`、以及注入 `cc_version=X.Y.Z.{fp}`(`SHA256(salt + firstUserMsg[4,7,20] + cliVersion)[:3]`)—— 否则请求被降级为第三方计费。
4. UI:Settings 网关页新增开关,**默认关闭**,明确风险文案(i18n 双写)。

**验收**(若决定做):OAuth 头构造单测、`cc_version` 指纹算法对拍 sub2api 参考值、金库刷新 mock 测试、开关默认 off 的 UI 测试;`pnpm changeset`。

---

## 4. W3 — 工程增强(P2,可选,按需取用)

### W3.1 — 上游错误分级:临时限流(冷却)vs 永久失效(禁用) **[CONFIRMED]**

**问题**:网关只有"重试状态码列表",不区分"这个 key 临时被限"和"这个 key 彻底废了"(insufficient_quota / org disabled / 401 无 refresh)。

**证据**:重试判定只看状态码(`types.rs:138` `should_retry`);TS 熔断器是**纯失败计数 FSM**,不分错误类型(阳性对照:`grep -in "401|quota|classify|insufficient" circuit-breaker-machine.ts` 全空)。两层都不区分。

**修法**(借 newapi Aho-Corasick 关键字禁用 + sub2api per-error-code 策略):在 W1.1 的冷却逻辑上分档 —— 429/529 → 冷却(W1.1);401(api-key)/ 命中 `insufficient_quota`、`organization has been disabled`、`deactivated_workspace` 等关键字 → 标记该 key **永久失效**并在状态里暴露给 UI(而非无限重试)。关键字列表进 `GatewayConfig`,可配。

**验收**:分档单测(429→冷却、quota 关键字→永久禁用、5xx→短 backoff);`rtk cargo test -p cognia-gateway`。**依赖 W1.1**。

### W3.2 — 剥离客户端危险透传字段(安全默认) **[CONFIRMED]**

**问题**:网关基本原样透传请求体(`execute.rs:273` `rewrite_model` 只改 `model`),客户端可注入 `service_tier`/`store`/`safety_identifier` 等影响计费/隐私/行为的字段。

**证据**:`grep -rn "service_tier|safety_identifier|strip|disabled_field" crates/cognia-gateway/src/translate` 全空 —— 无任何字段剥离。

**修法**(借 newapi `RemoveDisabledFields` 的**小子集**,不做全套 override DSL):在 translate 出站前,按 provider 白名单剥离一组默认危险字段(`service_tier`、`store`、`safety_identifier`、`stream_options.include_obfuscation` 等),白名单可 per-provider 放行。

**验收**:剥离单测(默认剥离、放行后保留);coverage ≥90%。

### W3.3 — reasoning-effort 作为虚拟模型后缀(+ 独立定价) **[CONFIRMED,价值最低]**

**问题 / 现状**:cognia 有"按名字模式识别是否支持 thinking"的能力(`lib/ai/reasoning-capability.ts:22`,匹配 `-thinking`/`-reasoning`),但**没有** newapi 那种"把 `gpt-5-high` / `claude-opus-thinking-max` 当作可选 catalog 模型,解析后缀 → base model + effort 档 + 独立定价"的路由/定价机制。

**修法**(借 newapi `setting/reasoning/suffix.go`):在 alias/model-mapping 解析处加后缀解析,把 effort 档还原成请求参数,并允许每档独立定价。纯 TS,`provider-routing` / catalog 层。

**验收**:后缀解析单测(`-high`/`-max`/`-low`/`-none` 各 provider 语义);catalog 暴露虚拟模型的测试。**优先级最低,可延后**。

### W3.4 — 走真实 relay 路径的上游自检端点 **[CONFIRMED]**

**问题**:`/healthz` 只返回 ok(`server.rs:235`),网关自身没有"用真实候选路径打一次上游"的自检;renderer 侧批量测试是另一套,不覆盖网关执行路径。

**修法**(借 newapi `testChannel` 用真实管线自检的思路):加 `/healthz/upstream`(loopback-only),对指定 alias/model 走**真实的候选解析 + 一次最小上游调用**,返回逐候选的 ok/失败+延迟。测试即生产路径。

**验收**:自检端点集成测试(mock 上游);仅 loopback 可达的安全测试。

---

## 5. 明确**不借**(SaaS / 多租户,不适配本地单用户桌面)

newapi/sub2api 大量设施与 cognia(本地 Tauri、单用户 / 局域网、借用户本人凭证)不匹配,**不纳入本计划**:

- **支付 / 兑换码 / 推广返利 / 订阅套餐商店**(sub2api §10、newapi Stripe/Creem)—— cognia 不向任何人计费。
- **拼车 / 多租户配额、RBAC/authz、per-user 钱包、ClickHouse 日志、Turnstile、Redis Cluster**—— 单进程,用进程内结构即可。
- **billing-expression DSL**(newapi `pkg/billingexpr`,是它最亮的工程,但那是"给别人算钱";cognia 的定价只用于**成本展示 + 选路**,现有 `model-pricing` 含缓存分档已够)。
- **Spark 影子账号、payment-instance 负载均衡、admin ops 大盘**—— 过于专门 / 多租户导向。

---

## 6. 建议实施顺序 + [OPEN] 待拍板

**顺序**:`W1.1(池内 key 冷却 + 头解析)` → `W1.3(激活亲和 + cache 块键)` → `W1.2(并发上限)` → `W3.1(错误分级,依赖 W1.1)`。四者都在 Rust 网关热路径、纯进程内、互相配合,直接改善 cognia 的真实场景,且**不碰 ToS 灰区**。W3.2/W3.4 随手可做;W3.3 最低优先。

**[OPEN] 待用户拍板**:

1. **W2(订阅 OAuth 上游 + 拟真)做不做?** 价值最大但明确踩 Anthropic/OpenAI ToS(sub2api README 首段即免责声明)。若做,建议**默认关闭 + UI 显著风险提示 + 仅本机**。请给方向:做 / 不做 / 只做 OAuth bearer 但不做指纹拟真。
2. **W1.1 的 429-无头 fallback 冷却默认值**(建议 20s,可关):要不要更保守 / 直接默认关?
3. **W1.2 并发满时的行为**:先做"直接 429"最简版,还是一步到位做"带超时排队"?

---

## 7. 参考锚点(行号会漂,按符号定位)

- 池轮询无冷却:`crates/cognia-gateway/src/execute.rs:26`(`ProviderKeyRotation`)、`:75`(`expand_key_pools`)、`:223`(`upstream_headers`,仅 x-api-key)
- 无并发/无头解析:`server.rs`(限流)、`keyed_rate_limit.rs`
- 熔断已支持 Retry-After(provider 粒度):`packages/provider-core/src/providers/circuit-breaker-machine.ts:11,27`
- outcome 转发不带 retry-after:`lib/gateway/telemetry-forwarder.ts:23`
- 亲和已建但休眠:`packages/provider-routing/src/session-affinity-store.ts:24`(`pinSessionDeployment` 零生产调用)、`filters/affinity.ts:25`、`decide.ts:33`(不传 sessionId)、`lib/claude/build-options.ts:1117`(chat 传了 sessionId)
- in-flight 桩:`packages/provider-routing/src/runtime-adapters.ts:118`(`getInFlight: () => 0`)、`strategies/built-in.ts:135`
- 订阅换 API key(非 OAuth):`lib/gateway/snapshot-publisher.ts:226`(`enrichSnapshotWithSubscriptionCreds`)
- reasoning 仅能力识别:`lib/ai/reasoning-capability.ts:22`
- 克隆源仓:session scratchpad `newapi`(QuantumNous)、`sub2api`(Wei-Shaw)
