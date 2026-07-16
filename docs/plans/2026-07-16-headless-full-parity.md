# 无头模式全功能对等 — 实施计划

**日期**: 2026-07-16
**状态**: 待评审(未动工)
**目标**: 服务器独占运行,桌面不参与;**凡在无头下有意义的功能**都与桌面对等
**范围**: 两部分 ——

- **Part A(H1–H8)**:IM 连接器全量对等 —— `crates/cognia-connectors` 传输层 + companion RPC 面 + 归属模型
- **Part B(C1–C6)**:平台能力探测与常驻触发 —— `lib/platform/capabilities.ts` + cron/alarm 常驻 + 剩余未抽取的 initializer

**明确不做**:纯桌面 UI / 硬件绑死的功能(桌宠、托盘、窗口 chrome、computer-use、native OCR…)—— 完整的纳入/排除判据见 **§2.0**。

**参考 ADR**: **0059**(云部署 / 无头 brain —— 本计划推翻其 T-A5 的一条前提 §1.3,并指出其 D4 清单失效 F11)、0060(能力词汇表 L0)、0061(跨设备执行)、0067(crate 分解)、0009 / 0025 / 0036(连接器)

> **Part A 与 Part B 基本独立,但有一条待确认的耦合。**
>
> **独立的依据** [CONFIRMED]:已核实 `connector-runtime` / `always-on` / `mcp-runtime` 这几个能力 id **只在 `lib/workflow/nodes/catalog.ts` 的节点 `requires` 里被真正检查**,连接器运行时不读它们(唯一的 `connector-runtime` 命中是 `lib/headless/runtimes/connector-runtime.ts:81` 的**运行时名字**,纯属重名)。所以 C1 的能力探测 bug **打不到 IM**。阳性对照:同形状搜 `"uia-automation"` 有命中,证明 grep 在工作。
>
> **唯一可能的耦合(已大幅缩小)**:C2 原本可能需要 H1 的 lease,但 F13 自我修正后 **C2 降级为验证项,大概率零代码关闭** —— 该耦合只在 U5 意外失败时才浮现。**Part A / Part B 实际可以并行。**

---

## 0. 如何使用本文档

每个工作项自成单元:问题 → 证据 → 修法 → 验收。除非标注 **依赖**,否则彼此独立,一项一个 commit。

### 0.1 置信标签

沿用 `2026-07-16-otel-native-telemetry.md` 的约定。**标签不是装饰。**

| 标签             | 含义                                        | 你必须做什么                                   |
| ---------------- | ------------------------------------------- | ---------------------------------------------- |
| **[CONFIRMED]**  | 本文作者亲手 grep/读代码核实,file:line 已对 | 可信,但行号会漂 —— **按符号重新定位,别按行号** |
| **[OPEN]**       | 真正未决,需要人来拍板                       | **不要默默替它做决定**,见 §7                   |
| **[UNVERIFIED]** | 作者的推断,证据链未闭合                     | **动手前先自行验证这条具体主张**               |

### 0.2 证据标准(不可妥协)

本文所有「零 / 不存在 / 未使用」的主张**均已跑阳性对照** —— 用同形状的命令去搜一个已知存在的词,确认工具本身在工作,再采信那个零。对照记录见各条目。你复核时请照做。

**这条规矩在本次调研里救了两次场,两次的假零长得都和真零一模一样:**

1. **zsh 吃掉了 glob。** `grep --include=*.ts`(未加引号)被 shell 展开,命令**静默失效返回空**。作者据此差点断定 `detectHostProfile` 无调用点。**是阳性对照暴露了它** —— 对照组报了同样的错,说明坏的是命令,不是事实。加引号(`--include="*.ts"`)后真相才出来:它有调用点。
2. **搜索范围漏了目录。** 作者搜 `lib components cli` 后断定 `initSchedulerSystem` **零消费方** —— 漏了 `stores/`。实际它在 `stores/scheduler/scheduler-store.ts:745` 被动态 import 调用。**这个假零若被采信,会推翻 F13 的整个修正**(见下)。

**第三条教训不属于「假零」,但更贵 —— 事实真、推论假:**

3. **F13 一度被判为致命缺口。** 「Rust cron daemon 在 cognia-server 里不存在」是**实证为真**的;但作者据此推出的「所以定时任务不会跑」**是错的** —— 计时驱动本来就是可插拔的,brain 走纯 TS 的 `RendererTimingDriver`,而 brain 常驻不关。**差点立成一个不必要的 Rust 项目。** 修正痕迹在 F13 里**故意保留**。
   > **由此得出本文的元规矩**:凡「X 在无头下不存在」的观察,**先问一句「那它在无头下还有存在的理由吗?」** —— 很多缺席是设计使然(driver 抽象、宿主差异),不是缺口。

**本计划全部结论来自读代码,没有实跑过容器。** H0 与 U6 分别是 Part A / Part B 的第一站 —— 它们同时是两个现存 bug 的复现,也是无头开发回路的打通。**U6 成本最低(不需要真 bot),建议最先做。**

---

## 1. 研究结论

### 1.1 好消息:架构本来就是为这个设计的

ADR-0059 D1 的原话是「**只换 brain 宿主,保留两平面**」。桌面是 `Rust 前门 + WebView 里的 TS brain`,无头是 `Rust 前门 + Node 进程里的同一份 TS brain`。业务逻辑(去重、策略、路由、PII gate、AI 出话、outbound 队列)**已经是一份代码在 Node 里跑了**,`lib/headless/runtimes/connector-runtime.ts` 跑的就是桌面 `ConnectorBusProvider` 用的同一个 `installConnectorRuntime()`。

**所以本计划不是「把 IM 搬到服务端」,而是「把传输层剩下的三个模块从 `tauri::AppHandle` 上摘下来」。** 工作量集中、机械、有界。

### 1.2 缺口的真实构成(三层,不是一层)

`connector-runtime.ts` 的注释只说了第一层。实际是三层:

| 层  | 内容                                                                          | 严重度       |
| --- | ----------------------------------------------------------------------------- | ------------ |
| L1  | `EventEmitter` trait 只有一个方法;三个 WS 模块绕过它直接 `app.emit()`         | 机械改造     |
| L2  | companion RPC 白名单里根本没有 `connectors_ws_*` / `connectors_lark_ws_*` arm | 机械改造     |
| L3  | **归属**:Web Locks 在 Node 里空转,跨不了进程 → 桌面+服务器双拨                | **设计决策** |

L3 是注释没提的,也是唯一需要人拍板的。**先做 L1/L2 再做 L3,中间态就是「长连接能拨了但没人管重复」—— 那个状态一旦部署出去就是双回复事故。**

### 1.3 本计划推翻的 ADR-0059 前提

`connector-runtime.ts:20-23` 写着:

> Dial-out WS channels ... need the Rust `EventEmitter` trait extension and are skipped with a log line — **the desktop keeps running them.**

「桌面继续跑长连接」是 T-A5 当初的兜底假设。**本计划的目标(服务器独占)与之直接冲突。** 这不是实现细节,是 ADR 级的前提变更 → 见 §7 [OPEN-1]。

---

## 2. 已核实的事实清单

> 行号截至 2026-07-16。**按符号重新定位,别按行号。**

### 2.0 纳入 / 排除判据 —— 先读这张表

判据一句话:**「这个功能在一台没有显示器的服务器上,对用户还有意义吗?」** 有 → 纳入;没有 → 排除并在 UI 上诚实降级(C6)。

**排除(无头下无意义,不做)**:

| 功能                                                 | 为什么无意义                                                 |
| ---------------------------------------------------- | ------------------------------------------------------------ |
| 桌面宠物 / 托盘 / fleet island                       | 纯桌面 overlay 窗口,没有屏幕就没有它                         |
| window-title / appearance / context-keys / AppSplash | WebView chrome 与视觉状态                                    |
| 退出确认 / 崩溃报告 / 同意授权对话框                 | 交互式模态,无人可点                                          |
| WindowShow / WebviewHeartbeat initializer            | 前者揭示窗口,后者是白屏看门狗 —— 都无窗口可管                |
| computer-use / `uia-automation`                      | 需要真实显示器 + OS 辅助功能 API                             |
| OCR **native backend**                               | Apple Vision 等本机硬件(cloud OCR provider 另议,见 [OPEN-5]) |
| `pty`(交互式终端标签页)                              | 可见终端 UI 才需要;**一次性 shell 执行不在此列**,见 F14      |
| storage-persistence                                  | `navigator.storage.persist()` 是浏览器 API                   |
| companion-boot                                       | 这是配对协议的**客户端**侧;brain 是服务端                    |

**纳入(无头下有意义,本计划要补)**:

| 功能                     | 工作项 | 为什么必须有                                                               |
| ------------------------ | ------ | -------------------------------------------------------------------------- |
| IM 连接器全量            | H1–H8  | 本计划的初衷                                                               |
| 能力探测认得出无头       | **C1** | 🔴 现存 bug,连锁打死一批工作流(F12)                                        |
| 定时触发                 | **C2** | 服务器必须会定时干活 —— 但**大概率已经能**(F13 自我修正后 C2 降级为验证项) |
| 外部 agent(acp-client)   | **C3** | 服务器的核心用途之一                                                       |
| 订阅 / provider 凭据     | **C4** | 没凭据就没 AI                                                              |
| 备份调度                 | **C5** | 服务器更该自动备份(无人值守)                                               |
| 能力降级矩阵 + D4 真清单 | **C6** | 否则 UI 继续放用户配注定不工作的东西                                       |

### F1. `EventEmitter` trait 只有 `emit_webhook` [CONFIRMED]

`crates/cognia-connectors/src/axum_app.rs:39-41`

```rust
pub trait EventEmitter: Send + Sync + 'static {
    fn emit_webhook(&self, adapter_id: &str, payload: &serde_json::Value);
}
```

两个 impl:`AppHandleEmitter`(:44-53,转 `app.emit`)、`BusEventEmitter`(`src-tauri/src/companion_api/server.rs:299-308`,转 `EventBus::publish`)。**只有 webhook 这条路走 trait**,所以只有它能在无头下换实现。

### F2. 三个 WS 模块直接吃 `tauri::AppHandle` [CONFIRMED]

| 模块                      | 签名 / 取得方式                                                |
| ------------------------- | -------------------------------------------------------------- |
| `ws_client.rs:49-50`      | `pub async fn open_ws(app: tauri::AppHandle, …)`               |
| `lark_ws.rs:277`          | `pub async fn open(app: tauri::AppHandle, adapter_id: String)` |
| `ws_server.rs:43,149,153` | 经 `AppHandleExt` extension layer                              |

### F3. 精确 topic 清单(改造面) [CONFIRMED]

**`ws_client.rs` — 5 个出站 topic**(注意 `/binary`,容易漏):

| topic                          | 行       | payload                                |
| ------------------------------ | -------- | -------------------------------------- |
| `connectors://ws/{id}/open`    | 122      | `()`                                   |
| `connectors://ws/{id}/message` | 138      | `String`                               |
| `connectors://ws/{id}/binary`  | 156      | `binary_event_payload(&bytes)`(base64) |
| `connectors://ws/{id}/close`   | 150, 166 | `close_event_payload(frame)`           |
| `connectors://ws/{id}/error`   | 165      | `String`                               |

出站发送**已经是命令**(`ws_send(handle_id, data)` :199)—— 对称,无需额外 seam。

**`lark_ws.rs` — 2 个出站 topic**:`connectors://lark-ws/{hid}/event`(546)、`/close`(319)。

**`ws_server.rs`(OneBot)— 4 出 + 1 入**:

| 方向       | topic                                                             | 行      |
| ---------- | ----------------------------------------------------------------- | ------- |
| emit       | `connectors://onebot/{id}/open`                                   | 244     |
| emit       | `connectors://onebot/{id}/response` \| `/event`(经 `route_frame`) | 265     |
| emit       | `connectors://onebot/{id}/close`                                  | 288     |
| **listen** | `connectors://onebot/{id}/send`                                   | **216** |

**OneBot 是唯一一个用 Tauri event 收出站的连接器** —— 别的都走 command。这条不对称正是 §6 H4 的关键,别按 lark_ws / ws_client 的模子估它的工作量。

### F4. RPC arm 缺失,且 dispatch 是严格白名单 [CONFIRMED]

`rpc.rs:1048`:

```rust
if !KNOWN_COMMANDS_SET.contains(name.as_str()) {
    return Err(RpcError::unknown_command(&name));
}
```

**阳性对照**:

```
grep -c "connectors_ws_open|connectors_ws_send|connectors_ws_close|
         connectors_lark_ws_open|connectors_lark_ws_close|connectors_reset_all_ws"  → 0
grep -c "connectors_http_request|connectors_keyring_get"                            → 12   ✅ 工具在工作
```

所以 brain 今天喊 `connectors_ws_open` 只会拿到 `unknown_command`。这与 `rowFilter` 的存在是自洽的:webhook 行永远不拨 WS。

**新增一个 arm 的触点(5 处,比想象多)**:

1. `KNOWN_COMMANDS`(`rpc.rs:186` 起的数组)
2. `SERVICE_ONLY_COMMANDS`(`rpc.rs:797`)—— 连接器 arm 都是 service scope
3. `dispatch()` 的 `match name` 分支(:1046 注释明写「keep in lockstep,drift 会静默绕过 503 路径」)
4. **`docs/api/mobile-companion-api.openapi.yaml`**
5. `spec_parity.rs::every_known_command_appears_in_the_openapi_spec` —— **双向**门禁,漏一边 CI 就红

> 另有 `READ_ONLY_COMMANDS`(509)、`CONTROL_COMMANDS`(619)、`CALLER_DEVICE_ID_COMMANDS`(768)三张名单,本计划的 arm 不涉及,但改之前先确认。

### F5. Web Locks 在无头下空转 [CONFIRMED]

`lib/connectors/bootstrap/install-connector-runtime.ts:162-164`:

```ts
function defaultAcquireRuntimeLock(signal: AbortSignal): Promise<boolean> {
  const locks = (globalThis as { navigator?: { locks?: LockManager } }).navigator?.locks
  if (!locks?.request) return Promise.resolve(true)   // ← 无 Web Locks 直接放行
```

`lib/headless/node-indexeddb.ts:48-58` 只 shim `window` / `localStorage` / `sessionStorage`,**完全不碰 `navigator`**。

**阳性对照**:

```
grep -c "navigator"    lib/headless/node-indexeddb.ts  → 0
grep -c "localStorage" lib/headless/node-indexeddb.ts  → 2   ✅ 工具在工作
```

实测 Node 20:`navigator` 本身就是 `undefined`。容器用 Node 22(`navigator` 存在但无 `locks`)—— 两种情况都走那个 `return true`。

**且 Web Locks 本来就是 per-origin/per-process 的,设计上就跨不了「桌面进程 ↔ 服务器进程」。** 换句话说:即便 Node 里有 Web Locks,它也解决不了本计划的归属问题。

后果:桌面与服务器同账号同时拨长连接 → 平台投两遍 → **双份回复**;Discord Gateway 还会撞 identify 限流 / session 上限。

### F6. 🔴 OneBot 反向 WS 在无头下是静默黑洞 —— **现存 bug,非未来风险** [CONFIRMED]

证据链(五环,全部闭合):

1. `axum_app.rs:76-82` — `build_unresolved_router()` **无条件**调用 `ws_server::register_routes(base)`
2. `ws_server.rs:118-120` — route 是 `/ws/onebot/{adapter_id}`;`server.rs:327` `nest("/connectors", …)` → 实际路径 **`/connectors/ws/onebot/{id}`**
3. `ws_server.rs:146-149` — `ws_onebot_handler(State(_state): State<ConnectorsState>, …)` —— **状态被下划线忽略**,鉴权只查 keyring(`onebotBearer`),**不要求 adapter 已注册**
4. `server.rs:321-325` — 无头装配 `build_router(…, None, // no OneBot reverse-WS AppHandle headless)`
5. `ws_server.rs:196-203` — `app` 为 `None` 时:
   ```rust
   None => ws.on_upgrade(|mut socket| async move {
       let _ = socket.recv().await;      // 收一帧,丢掉
   }),                                    // 闭包结束 → socket 析构 → 连接关闭
   ```

**实际行为**:NapCat 连上来 → 鉴权通过 → 发一帧 → 被踢 → 无限重连。消息一条不到,**且 drain 分支没有任何日志**(不像 `rowFilter` 至少打 skip 行)。

**为什么 `rowFilter` 拦不住**:这是**入站**连接打到 axum 的,不是 brain 拨出去的。`rowFilter` 只管 brain 注册/拨号什么,管不到 axum 的路由表。

**可达性**:需要 keyring 里有该 adapter 的 `onebotBearer`。`connectors_keyring_set` 是已存在的 RPC arm(`rpc.rs:248`),brain 能写。而 F5 能力矩阵(ADR-0059 Phase 2,**planned**)还没做 → UI 今天不会阻止你在云上配 OneBot bot。**触发条件齐了。**

**测试为什么没抓到**:`ws_server.rs:462` `ws_onebot_unauthenticated_optin_is_accepted` **只断言握手成功**(`assert!(result.is_ok(), "opt-in upgrade must succeed")`),从不断言帧被桥接。三个 onebot 测试(:449/:462/:481)全是鉴权测试。**drain 路径在测试里是绿的。**

**这正是 CLAUDE.md 规则 7 说的形态**:代码注释把 `None` 分支标为「the `build_unresolved_router` **test path**」(:193-195),但 `server.rs:324` 让它在无头生产里是活的 —— 文档轴与实现轴对不上,测试轴还把错的那个钉住了。

### F7. Lark send-as-user OAuth 在无头下断链 [CONFIRMED]

`axum_app.rs:118-136`(实际代码,非注释):

```rust
async fn oauth_lark_callback(RawQuery(raw_query): RawQuery) -> Response {
    let params = parse_query(raw_query.as_deref().unwrap_or(""));
    let deep_link = build_lark_oauth_deep_link(&params);   // → "cognia://connector/oauth/lark?…"
    lark_oauth_callback_page(&deep_link)                   // meta-refresh 弹自定义 scheme
}
```

无头没有 `cognia://` 的系统级 deep-link 处理器 → 兑换链断。**「所有 IM 功能」若含 send-as-user,这条必须补。**

### F8. `rowFilter` 现状 [CONFIRMED]

`lib/headless/runtimes/connector-runtime.ts:88`:`rowFilter: (row) => row.transportMode === "webhook"`
`install-connector-runtime.ts:421-428`:应用过滤 + 对每个被跳过的行打 info 日志(**不静默丢**,这点是好的)。

注意是 **per-row 而非 per-adapter**:同一个 Lark adapter,配 webhook 的实例跑,配长连接的实例被跳过。

### F9. transportModes 矩阵 [CONFIRMED]

逐个 `lib/connectors/adapters/*/index.ts` grep 得出:

| 平台            | 声明                                                        | 无头现状                           |
| --------------- | ----------------------------------------------------------- | ---------------------------------- |
| wechat-oa       | `["webhook"]`                                               | ✅ 全量                            |
| lark            | `[transport === "long-connection" ? "gateway" : "webhook"]` | ⚠️ 仅 webhook 模式                 |
| slack           | `[transport === "socket-mode" ? "gateway" : "webhook"]`     | ⚠️ 仅 webhook 模式                 |
| qq-official     | `["gateway", "webhook"]`                                    | ⚠️ 仅 webhook 模式                 |
| telegram        | `[transport]`(`"longpoll" \| "webhook"`)                    | ⚠️ 仅 webhook 模式                 |
| discord         | `["gateway", "webhook"]`                                    | ⚠️ **webhook 模式功能残缺,见 F10** |
| dingtalk        | `["gateway"]`                                               | ❌                                 |
| wecom           | `["gateway"]`                                               | ❌                                 |
| matrix          | `["longpoll"]`                                              | ❌                                 |
| onebot          | `["reverse-ws", "forward-ws"]`                              | ❌ **且是 F6 的黑洞**              |
| wechat-personal | `["longpoll"]`                                              | ❌                                 |

### F10. Discord webhook 模式收不到聊天消息 [CONFIRMED]

`lib/connectors/adapters/discord/transport-webhook.ts:1-21` 文件头明写:

> Discord's Interactions Endpoint URL delivers ONLY interactions (slash commands, message components, modal submits) — **it NEVER delivers message events** (`MESSAGE_CREATE` / DMs). Those require the Gateway with the MESSAGE_CONTENT intent.

**这是 Discord 平台限制,不是本仓的。** 所以「Discord 配 webhook 就能无头」是伪解 —— 它只能答按钮/斜杠命令。Discord 要收聊天消息,**必须**走 Gateway,即必须做完本计划的 H2/H3。

同文件还记了一条:webhook 模式下 modal-open(type-9)降级为普通回调,因为「Rust 路由无法同步构造 renderer Dexie 里的 modal 定义」。**注意:无头 brain 恰恰持有 Dexie** —— 所以 H2/H3 做完后,gateway-in-brain 反而能修好 modal,这是顺带收益。

---

## 2bis. Part B 的事实清单

### F11. ADR-0059 D4 的「不可用」清单**生来不全,且已过期** [CONFIRMED]

D4 是仓里唯一的正式清单:

> Not available in cloud (degraded/hidden): computer-use, OCR, native terminal into the host, desktop pet, native sqlite-vec (use the five cloud vector backends from ADR-0023).

**生来不全**:它漏了嵌入式浏览器。ADR-0055(Agent browser loop)**Accepted 2026-06-25**,比 0059(proposed 2026-07-02 / accepted 07-13)早**一周多** —— 写 D4 时浏览器已经在仓里了。

**已过期**:其后又有 15 篇 ADR,其中 0060(内容捕获,07-02)、**0072(浏览器录制,2026-07-16 —— 就是今天)**、0073(Chromium cookie 导入)都引入了桌面绑定能力,D4 一次未更新。

> **结论:本仓目前没有一份可信的「哪些功能依赖桌面」清单。** C6 的产出之一就是补上它。

### F12. 🔴 能力探测在无头下自称 `web`,连锁打死一批工作流 —— **现存 bug** [CONFIRMED]

证据链(五环,全部闭合):

1. `lib/workflow/runtime/orchestrator.ts:262` — `preflightCapabilities(validated, undefined, {…})`,第二参传 **`undefined`**
2. `lib/workflow/runtime/capability-preflight.ts:58-62` — 该参默认值 `local: readonly CapabilityId[] = detectLocalCapabilities()`
3. `lib/platform/capabilities.ts:117-119` — `detectLocalCapabilities()` = `PLATFORM_BASELINES[detectPlatform()]`
4. `lib/platform/detect.ts:38-43` — brain 里:`window` 已被 shim 成 globalThis(`lib/headless/node-indexeddb.ts:51`)、无 `__TAURI_INTERNALS__`、无 Capacitor → **返回 `"web"`**
5. `lib/platform/capabilities.ts:109` — `PLATFORM_BASELINES.web` = **`["webview"]`**

**后果**:无头 brain **自称有 webview(它没有)、自称没有 shell / sidecar / connector-runtime / always-on(它全有)**。`orchestrator.ts:269-283` 于是在 **t=0** 把 run 直接标 `failed`,错误码 `capability-missing:shell`,并写 `workflowRuns` + 派发 plugin error hook。

**受影响的节点**(`lib/workflow/nodes/catalog.ts` 声明 `requires:` 的):

| 能力                | 节点数                                | 该不该被拒                                  |
| ------------------- | ------------------------------------- | ------------------------------------------- |
| `always-on`         | 3(129 / 138 / 1137)                   | ❌ **不该** —— `SERVER_BACKED` 明写服务器有 |
| `shell`             | 6(763 / 771 / 779 / 787 / 935 / 1162) | ❌ **不该** —— 同上                         |
| `uia-automation`    | 15(795–888)                           | ✅ 该拒                                     |
| `pty`               | 7(899–962)                            | ✅ 该拒                                     |
| 移动能力(camera 等) | 5(634–662)                            | ✅ 该拒                                     |

**最刺眼的是矛盾就在同一个文件里**:`capabilities.ts:178-185` 的 `SERVER_BACKED` 明写无头服务器**有** `shell` / `sidecar` / `always-on` / `connector-runtime` / `mcp-runtime` / `headless`。但 `detectLocalCapabilities()` 从不问它 —— 因为 `PLATFORM_BASELINES` 压根没有 headless 这一档,而 `detectPlatform()` 的返回类型 `Platform = "tauri" | "mobile" | "web"` **在类型层面就表达不了 headless**。

**又一次「三轴缺一」**(CLAUDE.md 规则 7):

- 实现轴:`isHeadlessHost()` 存在(`detect.ts:66-68`,注释标 ADR-0059 T-A10)✓
- 文档轴:`capabilities.ts:34-35` 诚实写着 `headless` — "assigned to no webview platform here" ✓
- **但没有任何东西让 `detectLocalCapabilities()` 认得出无头** ✗

`isHeadlessHost()` 全仓**只有 `lib/ai/agent/external/agent-transport.ts` 一个消费方**(6 处),`capabilities.ts` 没 import 它。

### F13. cron / alarm 常驻在 cognia-server 里不存在 —— **但这是设计使然,不是 bug** [CONFIRMED]

> 🔴 **本条经过一次重大自我修正。作者最初判定这是「和 IM 断连同级」的致命缺口 —— 错了。** 事实(daemon 不存在)成立,**推论(所以定时任务不会跑)不成立**。留下修正痕迹,是因为下一个读者极可能踩同一个坑:看到「cron daemon 不存在」就去立一个 Rust 大项目。**别去。**

作者通读 `src-tauri/src/bin/cognia-server.rs` 全文确认:`run_serve` 依次装配 headless store → push creds → TLS 指纹 → `SharedState` → headless services → audit → metrics → `spawn_server` → brain supervisor。**没有任何一行启动 Rust cron daemon 或 alarm daemon** —— 那些只在桌面的 `src-tauri/src/lib.rs` setup 里装。

> ⚠️ **修正一条 [AGENT] 说法**:某 subagent 称这两个 daemon「installed unconditionally,在 headless 下 `app_handle: None` 会导致 emit 失败」。**不准确。** cognia-server 从不调用 `lib.rs` 的 setup,所以不是「装了但发不出」,而是**压根没装**。行为差别很大:前者会报错,后者是**彻底静默**。

TS 侧佐证 —— `lib/headless/runtimes/initializers.ts:8-10` 自陈:

> `installTriggerBridge` / `initDesktopEventTrigger` (workflow runtime) — Tauri-event sources; **the Rust cron daemon / desktop UIA watcher do not exist in cognia-server yet** (follow-up rides the events WS).

**但推论到此为止 —— 计时驱动是可插拔的** [CONFIRMED]。`lib/scheduler/task-scheduler.ts:178-181`:

```ts
// Resolve the timing driver: Rust alarm daemon on desktop (fires while
// [the app is closed]) …
this.driver = isTauri() ? new RustDaemonTimingDriver() : new RendererTimingDriver()
```

brain 里 `isTauri()` 为 **false**(无 `__TAURI_INTERNALS__`)→ 走 **`RendererTimingDriver`** → 纯 `setInterval`(:323/:344)。

而这条链是通的 [CONFIRMED]:`scheduler` runtime 已注册(`initializers.ts:22-48`)→ `useSchedulerStore.initialize()` → **`scheduler-store.ts:745-746` 动态 import 调 `initSchedulerSystem()`** → `registerBuiltInExecutors()` + `initTaskScheduler()`。

**所以 Rust alarm daemon 在 cognia-server 里缺席是对的**:它存在的唯一理由是「**app 关闭时也能触发**」,而服务器的 brain 是常驻守护进程,**永不关闭**。在服务器上,TS 驱动不只是够用,它就是正解。

> **交叉印证**:`docs/plans/2026-07-16-scheduler-subsystem-remediation.md:402` 从相反方向说了同一件事 —— 桌面版的架构天花板是「`agent`/`chat`/`plugin` 类定时任务需要活着的 app」,而它给出的突破口正是「让 CLI 起 headless 运行时」。**两份计划是同一条缝的两个方向:它把无头当解药,本文最初把缺 daemon 当病。解药是对的。**
>
> ⚠️ 那份计划称「`initializers.ts` 已有 `initSchedulerSystem` 的接线点 [AGENT]」—— **该说法成立**,只是间接(经 store 的动态 import)。作者一度误判它为「零消费方」,**原因是搜索范围漏了 `stores/`** —— 又一次假零,见 §0.2。

**所以 C2 剩下什么?** 只剩两条,且都不大:

- `installTriggerBridge` —— Rust cron daemon → Tauri event → TS 桥。若定时工作流确实走 TS 任务调度器(**U5**),这条纯粹是**桌面路径**,无头不需要。
- `initDesktopEventTrigger` —— 桌面 UIA watcher。**属于 §2.0 排除表**(`uia-automation`),本来就不做。

### F14. `shell` 在无头下可达,依赖很浅 [CONFIRMED]

`crates/cognia-terminal/src/headless.rs` 存在,自述:

> Headless terminal execution (**unattended workflow path**). Runs shell command lines in a _real_ shell with OSC 633 integration — but the PTY lives only in Rust: no `TerminalState` entry, no renderer session row, **no visible tab**.

> ⚠️ **两个「headless」不是一回事,别混**:这里的 headless = **没有可见的终端标签页**(workflow 节点的无人值守执行),它照样跑在桌面 Tauri 进程里。ADR-0059 的 headless = **没有 WebView**(cognia-server)。某 subagent 据此得出「terminal 在 cognia-server 里能用」—— **该结论不成立,是把两个词义混了**。

**但三方其实完全自洽**,没有矛盾:

| 来源            | 说法                                   | 指的是                  |
| --------------- | -------------------------------------- | ----------------------- |
| D4              | "native terminal into the host" 不可用 | 交互式可见终端 = `pty`  |
| `SERVER_BACKED` | 有 `shell`,无 `pty`                    | 一次性执行有,交互式没有 |
| `headless.rs`   | `terminal_headless_exec` 一次性执行    | 正好服务 `shell`        |

**依赖有多浅**:`headless.rs:541-550` `terminal_headless_exec<R: Runtime>(app: AppHandle<R>, …)` 吃 `AppHandle`,但**只用在 `resolve_dirs(&app)` 做路径解析**(全文件 `AppHandle` 仅 4 处)。换成一个显式路径参数即可摘掉 —— cognia-server 有 `COGNIA_DATA_DIR`。

> **这对 C1 是必要前提**:C1 让 brain 声称自己有 `shell`,那 6 个 shell 节点就**必须真能跑**,否则只是把 t=0 的诚实失败换成运行中途的脏失败。

---

## 3. 工作项总览

| #      | 工作项                                                              | 依赖        | 性质                     |
| ------ | ------------------------------------------------------------------- | ----------- | ------------------------ |
| **H0** | 复现并修 OneBot 无头黑洞(fail-closed + 日志)                        | —           | 🔴 **现存 bug,独立可发** |
| **H1** | 归属:服务端 lease 取代 Web Locks                                    | [OPEN-1]    | 设计                     |
| **H2** | `EventEmitter` trait 泛化 + 三模块摘 `AppHandle`                    | —           | 机械                     |
| **H3** | RPC arm:`connectors_ws_*` / `connectors_lark_ws_*` / `reset_all_ws` | H2          | 机械                     |
| **H4** | OneBot 出站:Tauri event → command(消除入站 seam)                    | H3          | 重构                     |
| **H5** | 放宽 `rowFilter`                                                    | H1,H2,H3,H4 | 一行                     |
| **H6** | Lark send-as-user OAuth 无头兑换路径                                | —           | 设计                     |
| **H8** | 无头 IM 端到端 smoke                                                | H5          | 验证                     |

> **H7 已并入 C6** —— 原 H7「F5 能力降级矩阵(UI)」与 Part B 的 C6 是同一件事,不拆两处做。编号保留空位,避免既有引用错位。

**Part A 顺序要点**:H1 必须在 H5 之前。H0 不依赖任何东西,应当**立刻单独发**。

### Part B — 平台能力与常驻

| #       | 工作项                                                                                                     | 依赖   | 性质              |
| ------- | ---------------------------------------------------------------------------------------------------------- | ------ | ----------------- |
| **C1**  | 能力探测认得出无头:`PLATFORM_BASELINES` 加 headless 档 + `detectLocalCapabilities()` 认 `isHeadlessHost()` | C1a    | 🔴 **现存 bug**   |
| **C1a** | 摘掉 `terminal_headless_exec` 的 `AppHandle`(路径参数化)                                                   | —      | 机械,C1 前提      |
| **C2**  | 定时触发:**验证项** —— 大概率开箱即通(F13 已自我修正)                                                      | U5     | ⬇️ 验证,非改造    |
| **C3**  | `external-agent-initializer` 抽取(ADR-0059 **T-A10**:acp-client 走 transport seam)                         | —      | 重构              |
| **C4**  | `subscription-initializer`:确认 R7 的 `claude_set_*` arm 是否真的够                                        | —      | 核查 → 可能无需改 |
| **C5**  | `backup-scheduler` 抽取(ADR-0059 **T-A6**:需注入 fs seam)                                                  | —      | 重构              |
| **C6**  | 能力降级矩阵接线 + 重写 D4 清单(含原 H7)                                                                   | C1, H5 | UI + i18n + 文档  |

**Part B 顺序要点**:**C1a → C1 是硬序** —— C1 让 brain 声称有 `shell`,C1a 必须先让 `shell` 真的能跑(F14),否则只是把 t=0 的诚实失败换成中途的脏失败。C2 是**验证项而非改造项**,先跑 U5 求证伪(大概率当场关闭)。C6 依赖 C1(没有正确的能力探测,矩阵就是错的)。

**Part A / Part B 可并行** —— 依据见文首注解(能力 id 不被连接器读取)。

---

## 4. 详细工作项

### H0 — 复现并修 OneBot 无头黑洞 🔴

**问题**: 见 F6。无头下 OneBot bot 连得上、认得过、消息全丢、零日志、测试全绿。

**修法(最小、fail-closed)**:

`ws_server.rs::upgrade` 的 `None` 分支不该静默 drain。改为**拒绝 upgrade 并打 error 日志**:

```rust
fn upgrade(ws: WebSocketUpgrade, emitter: Option<Arc<dyn EventEmitter>>, adapter_id: String) -> Response {
    match emitter {
        Some(e) => ws.on_upgrade(move |socket| run_bridge(e, adapter_id, socket)),
        None => {
            log::error!(
                "ws_server: refusing OneBot upgrade for {adapter_id}: no event sink installed \
                 (headless OneBot needs ADR-0059 H2/H4). Frames would be silently dropped."
            );
            (StatusCode::SERVICE_UNAVAILABLE, "onebot bridge unavailable").into_response()
        }
    }
}
```

> **注意**:H2 落地后这个 `None` 分支应当消失(emitter 永远有)。H0 是止血,不是终局。若 H2 排期很近,H0 可以只做「日志 + 503」而不动签名。

**测试改造(必须)**:

- 新增:`ws_onebot_headless_without_sink_refuses_upgrade` —— 断言 503 而非 101
- 修改:`ws_onebot_unauthenticated_optin_is_accepted`(:462)现在只断言握手成功。**它必须改成断言帧真的被桥接**,否则黑洞会以另一种形式回来。这条测试是本 bug 能活下来的直接原因。

**验收**:

1. 起一个 headless 容器,配一个 onebot adapter 的 bearer,用 `websocat` 连 `/connectors/ws/onebot/<id>` → **拿到 503 + 日志**,而不是 101 后静默
2. `cargo test -p cognia-connectors ws_onebot` 全绿

**为什么先做这个**:它同时是(a)现存 bug 的止血、(b)整个改造的第一站、(c)无头容器开发回路的打通。成本最低,信息量最大。

---

### H1 — 归属:服务端 lease

**依赖**: [OPEN-1] 拍板后动工。

**问题**: 见 F5。Web Locks 在 Node 空转 + 跨不了进程 → 双拨 → 双回复。

**推荐修法**: **服务端 lease,而不是部署模式开关。**

理由:桌面版这个产品还在,用户手上两边都有,**同账号误开是必然会发生的**,模式开关拦不住误操作。lease 必须放在双方都能看到的地方 —— companion API / `AppStore`(SQLite)。

设计草案:

- `install-connector-runtime.ts` 已有 `acquireRuntimeLock?: (signal) => Promise<boolean>` **测试 seam**(:125)—— **复用它,不要新造**
- 无头 brain 注入一个走 RPC 的实现:`connectors_runtime_lease_acquire` / `_renew` / `_release`(新 arm,走 H3 的同一套 5 触点流程)
- 租约带 TTL + 心跳续租;持有者崩溃后 TTL 过期自动释放
- 桌面端也注入同一个实现(当它连到云端 companion 时)→ 桌面抢不到就不 boot connector,并在 UI 提示「连接器由服务器持有」(i18n,双语)

**验收**: 桌面 + 服务器同账号同时启动 → 只有一方的 connector runtime 起来,另一方打出明确日志 + UI 提示;杀掉持有方 → TTL 内另一方接管。

---

### H2 — `EventEmitter` trait 泛化 + 三模块摘 `AppHandle`

**推荐修法**: 加一个**泛型** `emit`,而不是堆 10 个专用方法。

```rust
pub trait EventEmitter: Send + Sync + 'static {
    /// 通用出站事件。topic 由调用点格式化 —— trait 不需要知道 topic 分类学。
    fn emit(&self, topic: &str, payload: serde_json::Value);

    /// 保留为便利方法(既有调用点不动)。
    fn emit_webhook(&self, adapter_id: &str, payload: &serde_json::Value) {
        self.emit(&format!("connectors://webhook/{adapter_id}"), payload.clone());
    }
}
```

两个 impl 都天然泛型:`AppHandleEmitter` → `app.emit(topic, payload)`;`BusEventEmitter` → `bus.publish(topic, payload)`。

签名改造:

- `ws_client.rs:49` `open_ws(app: tauri::AppHandle, …)` → `open_ws(emitter: Arc<dyn EventEmitter>, …)`
- `lark_ws.rs:277` `open(app: tauri::AppHandle, …)` → `open(emitter: Arc<dyn EventEmitter>, …)`
- `ws_server.rs` `AppHandleExt` → `EmitterExt`(已存在!`axum_app.rs:57-58`)—— **`build_router` 的 `app: Option<tauri::AppHandle>` 参数应当整个删掉**

> 🔴 **线格兼容性(必须逐个核对)**
> payload 类型现在是混的:`()`、`String`、`serde_json::Value`。统一成 `Value` 时**必须保持线格不变**,否则 TS 侧监听器会静默解析失败:
>
> - `()` → `Value::Null`:两者都序列化成 `null` ✅
> - `String` → `Value::String(s)`:两者都序列化成 JSON 字符串 ✅
> - `binary_event_payload` / `close_event_payload` 已经是 `Value` ✅
>
> **结论是线格不变,但这条必须用测试钉住**,不能靠推理。每个 topic 加一条断言 payload JSON 形状的测试。

**验收**: 桌面行为零变化(既有连接器测试全绿)+ 每个 topic 的 payload 形状测试。

---

### H3 — RPC arm

**依赖**: H2。

新增 arm:`connectors_ws_open` / `_send` / `_close`、`connectors_lark_ws_open` / `_close`、`connectors_reset_all_ws`(**真实现**)。

每个 arm 走 F4 列的 **5 个触点**:`KNOWN_COMMANDS` → `SERVICE_ONLY_COMMANDS` → `dispatch()` match 分支 → OpenAPI yaml → `spec_parity` 绿。

**顺带清掉三个假实现** —— `connector-runtime.ts:57-64` 现在是:

```ts
case "connectors_start_server":  return "companion:/connectors" as T   // 合理:ingress 常挂
case "connectors_stop_server":   return undefined as T                 // 合理:无本地 server
case "connectors_reset_all_ws":  return 0 as T                         // ❌ 假的!
```

前两个是合理的 host no-op(无头 ingress 常挂、brain 无本地 axum),**但第三个是谎报**。桌面 boot 第 3 步会「reap 上个 webview 泄漏的 WS 句柄」;无头下句柄活在 **cognia-server 进程**里,brain 重启后它们会泄漏,而 `reset_all_ws` 返回 0 表示「没什么好清的」。**H3 必须给它真实现,并让 brain 在 boot 时真的调用。**

**验收**: brain 重启 → server 侧残留句柄被清 → `connectors_reset_all_ws` 返回真实清理数。

---

### H4 — OneBot 出站:Tauri event → command

**依赖**: H3。

**这是本计划最有价值的设计决定,值得单独读。**

见 F3:**OneBot 是唯一用 Tauri event 收出站的连接器**(`run_bridge` :216 `app.listen("connectors://onebot/{id}/send")`)。别的连接器出站都走 command(如 `ws_client.rs:199 ws_send`)。

天真的做法是给 trait 再配一个「入站 listen seam」,镜像 event 模型。**不要这么做。** 正确做法是**消除这条不对称**:

- 新增 arm `connectors_onebot_send(adapter_id, call_json)`,server 侧直接路由到活着的 socket
- TS 侧 onebot adapter 的出站从 `emit(…/send)` 改成走**已有的** `setConnectorCommandInvoker` seam

这样 brain→server 方向天然是 RPC(它本来就是),**整个「入站 event seam」的需求消失了**。同时 `run_bridge` 里那套 `app.listen` / `app.unlisten` / `send_listeners()` 全局表(:216-238)可以一并删掉 —— 少一个全局可变状态。

**代价**: 这是**桌面侧的线格变更**(event → command),需要 onebot adapter 的 TS 测试同步改。**这是本计划唯一会动桌面行为的一项** —— 评审时重点看。

**验收**: 桌面 OneBot 收发不变(既有 onebot 测试改造后全绿)+ 无头 OneBot 端到端收发通。

---

### H5 — 放宽 `rowFilter`

**依赖**: H1、H2、H3、H4 **全部完成**。

`connector-runtime.ts:88` 从 `row.transportMode === "webhook"` 放宽。

**建议分两步,不要一把梭**:

1. 先放 `["webhook", "longpoll"]` —— longpoll 是纯 TS HTTP 轮询,走已存在的 `connectors_http_request` arm,**[UNVERIFIED] 推断它不需要 H2/H3**。若成立,这一步白捡 telegram-longpoll / matrix / wechat-personal 三个平台,**且不依赖 H2/H3**。动手前先验证这条。
2. H1–H4 全绿后再放 `gateway` / `reverse-ws` / `forward-ws`。

**验收**: 每放宽一类,跑一遍 H8 的 smoke。

---

### H6 — Lark send-as-user OAuth 无头兑换

**问题**: 见 F7。`cognia://` deep-link 在无头下无人接。

**修法方向(需设计)**: 让 `oauth_lark_callback` 在无头下**不弹 scheme**,改为直接把 `code`+`state` 投到 EventBus(`connectors://lark-oauth/callback`),由 brain 的 TS 侧完成 state 校验 + PKCE 兑换 —— 兑换逻辑本来就在 renderer(`axum_app.rs:112-113` 注释:「all validation (state, PKCE) happens in the renderer」),而 brain 就是 renderer 的同一份代码。

分支条件用 `headless_services().is_some()`,与 `server.rs:318` 的 ingress 挂载判据保持一致。

**验收**: 无头下走完一次 Lark send-as-user 授权。**需要真 bot,见 §7 [OPEN-3]。**

---

### H7 — 已并入 C6

原「F5 能力降级矩阵(UI)」与 Part B 的 C6 是同一件事 —— 见 **§4bis C6**。编号保留空位。

---

### H8 — 无头 IM 端到端 smoke

**依赖**: H5。

`scripts/smoke/compose-smoke.mjs` 已有 `--tier server`,覆盖 pair → chat → agent → **connector webhook in**。

扩一档 `--tier im`:每个放宽后的 transport 各跑一条「入站 → AI 出话 → 出站」。OneBot 可用仓里已有的 stub 思路(参考 `COGNIA_SMOKE_AGENT` / `stub-acp-agent.mjs` 的 fail-closed 门禁写法:**默认惰性,仅在显式 env 下启用**)。

---

## 4bis. Part B 详细工作项

### C1a — 摘掉 `terminal_headless_exec` 的 `AppHandle` 🔧

**依赖**: 无。**是 C1 的硬前提。**

**问题**: 见 F14。`headless.rs:541-550` 只为 `resolve_dirs(&app)` 吃了个 `AppHandle`。

**修法**: 把 `resolve_dirs` 需要的两个路径(`script_dir`、`path`)提成显式参数或一个轻量 `TerminalDirs` 结构;桌面从 `AppHandle` 取,cognia-server 从 `COGNIA_DATA_DIR` 取。全文件 `AppHandle` 仅 4 处,改动面很小。

**验收**: `cargo test -p cognia-terminal` 绿;cognia-server 里能跑通一条 `terminal_headless_exec`。

---

### C1 — 能力探测认得出无头 🔴

**依赖**: C1a。

**问题**: 见 F12。brain 自称 `web`,能力集 `["webview"]` —— 既谎报有 webview,又漏报 shell/always-on。

**修法**:

1. `detect.ts` — `Platform` 类型加 `"headless"`,`detectPlatform()` **首先**问 `isHeadlessHost()`:

   ```ts
   export type Platform = "tauri" | "mobile" | "web" | "headless"

   export function detectPlatform(): Platform {
     if (isHeadlessHost()) return "headless" // ← 必须最先,brain 的 window 是 shim 的
     if (typeof window === "undefined") return "web"
     if ("__TAURI_INTERNALS__" in window) return "tauri"
     if (capacitorIsNative()) return "mobile"
     return "web"
   }
   ```

   > 🔴 **顺序是关键**:brain 把 `window` shim 成了 globalThis(`node-indexeddb.ts:51`),所以 `typeof window === "undefined"` 这一支**永远不会命中** —— headless 判断必须排在最前面。

2. `capabilities.ts` — `PLATFORM_BASELINES` 加 headless 档。**直接复用同文件已有的 `SERVER_BACKED`**(:178-185),别新造一份会漂移的清单:

   ```ts
   headless: Object.freeze([
     "shell", "sidecar", "always-on", "connector-runtime", "mcp-runtime", "headless",
   ] as const),   // === SERVER_BACKED;两者必须用同一个常量,加测试钉住
   ```

   **注意**:**不含** `webview` / `pty` / `uia-automation` / `ocr` / `keyring` —— 这正是与 F12 表格「该不该被拒」一列对齐的结果。

3. 加一条测试钉住 `PLATFORM_BASELINES.headless === SERVER_BACKED`(两者漂移必红)。

**顺带修好的**:

- 工作流预检:3 个 `always-on` + 6 个 `shell` 节点在 brain 里不再被 t=0 打死
- C6 的能力矩阵从此有正确的输入
- D4 那份清单第一次有了**代码里的**真相来源

> ⚠️ **`keyring` 的归属存疑** [UNVERIFIED]:无头用的是加密文件 store(ADR-0059 W5)而非 OS keyring,但 `keyring:*` secret ref 在无头下**是**能解析的。它算不算 `keyring` 能力?`SERVER_BACKED` 没列它。C1 动工前需确认 —— 列错会让一批 secret-ref 节点被误拒。

**验收**: brain 里 `detectLocalCapabilities()` 返回 headless 基线;一个含 shell 节点的工作流在 cognia-server 里**跑通而不是 t=0 失败**;桌面/移动/web 三档零变化。

---

### C2 — 定时触发:**先验证,大概率无需改** ⬇️

**依赖**: U5(+ U8,仅当 U5 结论意外时)。

> ⬇️ **本项已从「🔴 设计 + Rust 大改」降级为「验证项」。** 见 F13 的自我修正 —— 计时驱动本来就是可插拔的(`task-scheduler.ts:181`),brain 走 `RendererTimingDriver`(纯 `setInterval`),而 brain 是永不关闭的守护进程。**Rust alarm daemon 在服务器上缺席是对的。**

**任务是证伪,不是开工**:

1. **U5** —— 在 cognia-server 里排一个定时任务,确认它到点自己跑。**大概率直接通过**,那样 C2 当场关闭。
2. 若通过,顺带确认定时**工作流**(不只是 task)也走同一条 TS 调度器路径。既有 scheduler 计划提到 `workflow` 是「OS 提升」支持的任务类型之一,**暗示走的是同一条路 [UNVERIFIED]**。
3. 只有当 (1) 或 (2) 失败,才需要考虑把 Rust daemon 落进 `run_serve` —— **那时才去看 U8**(要不要 H1 的 lease)。

**若真要做 Rust 路径(小概率)**:两个 daemon 现在都吃 `AppHandle` 发事件(`AppHandleTaskDueEmitter` / `AppHandleEmitter`),**与 H2 是同一形状的问题,复用同一个解法** —— emitter trait + `BusEventEmitter` 走 `/ws/v1/events`。

**验收**: 一个定时任务 + 一个定时工作流在 cognia-server 里到点自己跑起来;进程重启后仍会跑。**理想结局是这条验收开箱即过,C2 零代码关闭。**

---

### C3 — `external-agent-initializer` 抽取(T-A10)

**依赖**: 无。

`initializers.ts:14-16` 自陈:

> `external-agent-initializer` — rehydrates the RENDERER-side manager; the brain drives agents through the service-scope RPC arms (R11) **until T-A10 reroutes acp-client through the transport seam**.

所以今天无头是**能**跑外部 agent 的(走 R11 的 service-scope arm),只是 renderer 侧 manager 的状态没有 rehydrate。T-A10 是既有 follow-up,本计划把它纳入。

**已有的抓手**:`lib/ai/agent/external/agent-transport.ts` 是全仓**唯一**消费 `isHeadlessHost()` 的地方(6 处)—— 说明这条路已经开了个头,C3 是把它走完。

**验收**: brain 重启后外部 agent 会话状态正确恢复。

---

### C4 — `subscription-initializer`:先核查,可能无需改

**依赖**: 无。**这是一个核查项,不是默认的改造项。**

`initializers.ts:11-13` 自陈:

> `subscription-initializer` — keyed to the interactive account unlock and uses toast i18n; the brain's provider creds arrive via the `claude_set_*` arms instead (R7).

**所以设计上无头是靠 R7 的 arm 拿凭据的,不需要这个 initializer。** C4 的任务是**验证这个说法成立**,而不是上来就抽取:

1. 无头下 provider 凭据是否真能完整解析(含 Codex device-code OAuth、Claude token —— D4 声称两者都 headless-friendly)
2. 订阅额度 / 限流状态在无头下是否可见
3. 若发现缺口,再决定抽取范围

**验收**: 无头下用 Codex + Claude 各跑通一轮真实对话;若无缺口,C4 关闭并把结论写回 ADR。

---

### C5 — `backup-scheduler` 抽取(T-A6)

**依赖**: 无。

`runtimes/index.ts` 自陈:「Pending extraction (tracked ADR-0059 T-A6): backup-scheduler (**needs an injected fs seam**)」。

无人值守的服务器比桌面**更**需要自动备份。fs seam 在无头下指向容器的 `/data` 卷(`COGNIA_DATA_DIR`)。

**验收**: cognia-server 按计划自动产出备份到 `/data`;重启后计划仍在。

---

### C6 — 能力降级矩阵接线 + 重写 D4 清单(含原 H7)

**依赖**: C1(没有正确的能力探测,矩阵就是错的)、H5。

**问题(两个)**:

1. **F5 的机器建好了,只接了一个 feature。** 链条 `capabilities.ts → hooks/use-host-profile.ts → components/platform/capability-gate.tsx` 全都在,但 `CapabilityGate` 全仓**唯一**的消费方是 `components/settings/pet/pet-section.tsx:58`(`profiles={["desktop"]}`)。computer-use、OCR、终端、浏览器、sqlite-vec —— 一个都没接。
2. **D4 清单失效**(F11)。

**修法**:

- 用 `CapabilityGate` 把 §2.0「排除」表里的每一项都接上(桌宠已接,照它的样子)
- **`CORE_CAPABILITY_IDS` 缺一个 `browser` 能力 id** —— 所以嵌入式浏览器既进不了 D4 清单,也进不了任何门禁。是否新增取决于 [OPEN-4]
- 把 D4 改写成一份由 `PLATFORM_BASELINES.headless`(C1 的产物)**推导**出来的清单,而不是手写的散文 —— 手写的那份已经证明会漂

> ADR 原话:「per-feature capability flags already exist for mobile — **extend, don't fork**」。别新造门禁机制。

**验收**: 云端 transport 下,§2.0「排除」表的每一项在 UI 上被禁用并给出理由;`pnpm lint:i18n` 绿(双语 key);D4 与代码一致(加测试钉住)。

---

## 5. 不在本计划范围内

- **dingtalk / wecom 补 webhook 模式**:它们只声明 `["gateway"]`。**[UNVERIFIED]** 我推测平台侧支持回调,但**没查文档**。若属实,补 adapter 的 webhook transport 比走 H2/H3 便宜,但那是独立工作项,不是本计划的前置。
- **无头镜像瘦身**:`Dockerfile.cognia-server:33-34` 自陈无头镜像仍整份编译并动态链接 Tauri 桌面栈(`libwebkit2gtk` 等),「no-tauri cargo feature」是 ADR-0059 的 tracked follow-up。与本计划正交。
- **ADR-0059 F1 / F3**(web transport、账号模型):独立。
- **§2.0「排除」表里的所有功能**:桌宠、托盘、窗口 chrome、computer-use、native OCR 等 —— 无头下无意义。本计划只在 **C6** 里让它们**诚实降级**,不做任何移植。
- **headless Chromium**:见 [OPEN-4]。若拍板走 (c),另立项。
- **`pty` 交互式终端**:排除。但**一次性 `shell` 执行纳入**(C1a) —— 别把这两个混为一谈,见 F14。

---

## 6. 风险

| 风险                                                                                                                                                                                                                                                                                                                                                                                                        | 缓解                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **H4 动桌面线格** —— 唯一会改桌面行为的一项                                                                                                                                                                                                                                                                                                                                                                 | 评审重点;onebot TS 测试先改后发;桌面回归                                                                                                                                                               |
| **H2 payload 线格漂移** —— TS 监听器静默解析失败                                                                                                                                                                                                                                                                                                                                                            | 每 topic 一条 payload 形状断言(见 H2 的 🔴 段)                                                                                                                                                         |
| **`/ws/v1/events` 扛不住 gateway 帧率** [UNVERIFIED] —— webhook 是每消息一次,gateway 是**每帧**一次(含心跳/presence),量级差一个数量级;若 `/ws/v1/events` 有限流或体积上限会被打爆                                                                                                                                                                                                                           | **H2 之前先测**:量一下 Discord gateway 的实际帧率,核 `/ws/v1/events` 的限流/体积配置。必要时在 Rust 侧过滤心跳类帧再 emit                                                                              |
| **中间态双回复** —— H2/H3 先于 H1 落地                                                                                                                                                                                                                                                                                                                                                                      | H5 是唯一放开阀门的地方,且依赖 H1;**H2/H3 单独落地不改变任何运行时行为**(rowFilter 仍卡着)                                                                                                             |
| 全局可变状态跨进程 —— `handles()` / `live_client_map()` 活在 server,brain 持 id                                                                                                                                                                                                                                                                                                                             | H3 的 `reset_all_ws` 真实现 + brain boot 时调用                                                                                                                                                        |
| 🔴 **C1 没配 C1a = 把诚实失败换成脏失败** —— preflight 存在的理由就是「避免 executor 在跑了一半、已产生副作用之后才抛」。C1 让 brain 声称有 `shell`,若 `shell` 实际跑不了,失败点就从 t=0 挪到了半途**带副作用**处                                                                                                                                                                                           | **C1a → C1 是硬序**,不可颠倒;C1 的验收必须包含「含 shell 节点的工作流真跑通」,而不只是「能力集对了」                                                                                                   |
| ⬇️ **C2 的归属问题(已大幅缩小)** —— **若**桌面和服务器共享同一份工作流数据、两边都跑定时,任务会**执行两遍**,且比长连接双拨更隐蔽(无「双回复」这种显眼症状,只有静默的重复副作用)。**但 C2 已降级为验证项**(F13),且前提本就未验证:brain 的 Dexie 与桌面的 Dexie 是**两个独立的库**。对照:IM 的双拨**与数据同步无关**(两边用同一套 bot 凭据连同一个平台,平台不在乎谁拨的)—— 所以 **H1 是无条件成立的,C2 不是** | U5 通过 → 本风险作废。U5 意外失败 → 再答 U8,若确认可共享则复用 H1 的 lease,别另造机制                                                                                                                  |
| ⚠️ **「看到缺失就开工」的元风险** —— 本文 F13 是活教训:「Rust cron daemon 在 cognia-server 里不存在」是**真的**,但推出的「所以定时任务不会跑」是**假的**,差点立成一个不必要的 Rust 项目                                                                                                                                                                                                                     | **凡「X 在无头下不存在」的观察,先问一句「那它在无头下还有存在的理由吗?」** —— 很多缺席是设计使然(driver 抽象、宿主差异),不是缺口。F13 那条修正痕迹是故意留的                                           |
| `Platform` 类型加 `"headless"` 成员的爆炸半径                                                                                                                                                                                                                                                                                                                                                               | `PLATFORM_BASELINES: Record<Platform, …>` 会**强制**补齐(好事,编译器帮你找全);但**没有 `default` 分支的 `switch (platform)` 会静默漏掉 headless** —— C1 动工时全仓搜 `detectPlatform()` 的消费方逐个过 |

---

## 7. 待拍板 [OPEN]

### [OPEN-1] 桌面共存 vs 服务器独占 —— **这条决定 H1 的形状,必须先答**

ADR-0059 T-A5 的兜底是「桌面继续跑长连接」(F3/§1.3)。本计划的目标(服务器独占)与之冲突。两个选项:

- **(a) 服务器独占,桌面永不跑 connector** —— H1 退化成一个部署模式开关,便宜。但**拦不住误操作**:用户手上有桌面版,同账号一开就双拨。
- **(b) 二者皆可,单持有者** —— H1 是真 lease(§4 H1 的草案)。贵一点,但对误操作是鲁棒的。

**作者推荐 (b)**,理由见 H1。但这是产品决策,不是技术决策 —— **不要默默替它做决定**。

### [OPEN-2] 要不要开 ADR?

本计划推翻 ADR-0059 的一条明文前提(§1.3),且 H4 改桌面线格。**作者认为至少需要 ADR-0059 修订(加一个 F6 wave),而不是纯计划文档。** 需拍板。

### [OPEN-3] H6 / H8 的真 bot 凭据

Lark send-as-user、OneBot、Discord gateway 的端到端验证都需要真凭据。谁提供?哪个环境?

### [OPEN-4] 嵌入式浏览器怎么办 —— **它不是桌宠**

排除桌宠很容易(没屏幕就没意义)。**浏览器不一样**:ADR-0055 叫 "Agent browser loop" —— 一个能上网、能操作页面的 agent,在服务器上是**有意义**的,甚至是核心用途。所以不能照桌宠的理由排除它。

但现有实现是 Tauri WebView 绑死的(`src-tauri/src/browser/embedded.rs` 全员 `#[cfg(desktop)]` + `Window::add_child`),无头要的是 headless Chromium —— **那是另一个量级的工程,不该塞进本计划**。

三个选项:

- **(a) 明确排除**,在 C6 里诚实降级。代价:无头 agent 不能浏览网页。
- **(b) 用现有的 web 工具兜底**:`lib/web/reader/`、`lib/web/web-tools-core.ts`(ADR-0060)是纯 HTTP fetch + 解析,**无头可用**。够不够取决于用途 —— 读网页够,操作页面不够。
- **(c) 单开一份 headless Chromium 的计划**。本计划不碰。

**作者倾向 (b) 兜底 + (c) 另立项**,但需拍板。**无论选哪个,`CORE_CAPABILITY_IDS` 都缺一个 `browser` 能力 id**(C6 已记)。

### [OPEN-5] cloud OCR 要不要保留

D4 一句话排除了 "OCR"。但 OCR 子系统(ADR-0024)是有 **cloud provider** 的 —— 只有 native backend(Apple Vision 等)是硬件绑定。

所以「OCR 在无头下不可用」这个说法**可能过粗**:cloud OCR 在服务器上应当是可用的。若认可,C1 的 headless 基线要不要含 `ocr`?**但 `ocr` 是单一能力 id,分不出 native / cloud** —— 可能需要拆 id,或在 provider 层降级而非能力层。需拍板。

---

## 8. 未验证清单(动手前自行核实)

| #      | 主张                                                                                        | 影响                                                                                                                                             |
| ------ | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| U1     | telegram longpoll / matrix / wechat-personal 不需要 H2/H3,放宽 `rowFilter` 即可             | 若成立,H5 第一步能白捡 3 个平台且**不依赖 H2/H3** —— 可能比整个 H2–H4 还划算,**优先验证**                                                        |
| U2     | dingtalk / wecom 平台侧支持回调                                                             | 决定 §5 那条是否值得单开工作项                                                                                                                   |
| U3     | `/ws/v1/events` 能扛 gateway 帧率                                                           | 见 §6;H2 的前置                                                                                                                                  |
| U4     | F6 黑洞的完整链条(五环推理,未实跑)                                                          | H0 的验收就是它的复现                                                                                                                            |
| **U5** | 定时任务在 cognia-server 里到点是否真的自己跑                                               | **已基本答出**(F13):驱动可插拔,brain 走 `RendererTimingDriver` + `setInterval`,且 brain 常驻。**剩下的只是实跑确认一次** —— 通过则 C2 零代码关闭 |
| **U6** | F12 链条(五环推理,未实跑)—— brain 里 `detectLocalCapabilities()` 是否真的返回 `["webview"]` | C1 的前提。**验证成本极低**:在 brain 里打一行日志,或跑一个含 shell 节点的工作流看是否 t=0 失败                                                   |
| U7     | `keyring` 能力在无头下的归属(见 C1 的 ⚠️ 段)                                                | 列错会让一批 secret-ref 节点被误拒                                                                                                               |
| U8     | desktop ↔ server 的同步拓扑能否让同一个 workflow 行同时存在于两边                           | ⬇️ **仅当 U5 意外失败、C2 真要走 Rust 路径时才需要答**(决定是否复用 H1 的 lease)。U5 通过则本条作废                                              |

> **本计划全部结论来自读代码,零实跑。** U4 / U6 尤其:两者都是从五处代码推出来的,作者认为链条闭合,但**没有真起一个容器验证过**。H0 / C1 的第一步分别就是把它们复现出来 —— 如果复现不了,F6 / F12 及其结论需要重写。
>
> **U6 的验证成本远低于 U4**(不需要 NapCat,不需要真 bot),**建议先做 U6** —— 它能用最小代价证伪或坐实 Part B 的整个前提。
