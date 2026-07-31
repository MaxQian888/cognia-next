# 远程开发 / 连接远程 Cognia 主机 — 实施计划

**日期**: 2026-07-17
**状态**: 待评审(未动工)
**目标**: 让本地桌面 UI 驱动**一台远程机器**上的终端 / 文件 / 编辑器 / agent,就像它们在本地一样;并把"在远端把 Cognia 立起来"这一步纳入产品。
**一句话结论**: 远程开发的**底座已经建好约 85%**,而且是传输无关、多入口同构的。这**不是**一个"造 SSH 工具"的项目——SSH 只在两个很窄的角色里真正需要(provisioning + 无 cloudflared 时的隧道 fallback),外加一个可选的独立功能(连非-Cognia 裸主机的 shell)。**主体工作是把已建好的远程 API 从客户端外向接起来,而不是重复实现终端 / RPC / 事件 / WAN 机制。**

**范围**: 三阶段 7 个工作项(R0–R7)+ 5 个 [OPEN] 决策。
**明确不做**: 重造 RPC 数据面、重造终端 PTY、重造事件流、重造配对/鉴权、重造 WAN 可达——**这些全部已存在,见 §2。**

**参考 ADR**: **0021**(WebRTC WAN 传输 —— 关键约束 §2 F9)、**0031 / 0033**(集成终端 / headless 终端执行)、**0059**(云部署 / 无头 brain / 两平面)、**0061**(跨设备执行)、**0077**(外部 agent 托管 seam)、k8s-exec changeset(`ExecBackend` 三后端)
**参考姊妹计划**: **`2026-07-16-headless-full-parity.md`**(让远端 cognia-server 能力完整 —— 本计划的上游依赖,见 §6)、`2026-07-16-tui-external-agent-hosting.md`、`2026-07-16-tui-gui-linkage-remediation.md`

> **本计划全部结论来自读代码,没有实跑过远程部署。** 每个工作项都显式拆成「**复用(既有,file:line)**」与「**新建**」两栏 —— 这是"不要重复实现"落到纸面的形态。动手前请按符号重新定位行号。

---

## 0. 如何使用本文档

沿用 `2026-07-16-headless-full-parity.md` 的约定。**标签不是装饰。**

| 标签             | 含义                                        | 你必须做什么                                   |
| ---------------- | ------------------------------------------- | ---------------------------------------------- |
| **[CONFIRMED]**  | 本文作者亲手 grep/读代码核实,file:line 已对 | 可信,但行号会漂 —— **按符号重新定位,别按行号** |
| **[OPEN]**       | 真正未决,需要人来拍板                       | **不要默默替它做决定**,见 §5                   |
| **[UNVERIFIED]** | 作者的推断,证据链未闭合                     | **动手前先自行验证这条具体主张**               |

**证据标准**: 所有「零 / 不存在」主张均跑了阳性对照(同形状命令搜一个已知存在的词,确认工具在工作)。对照记录附在各条目。

---

## 1. 研究结论

### 1.1 好消息:远程开发的底座本来就在

Cognia 的架构是 **`Rust 前门 + 一份 TS brain`**,brain 既能跑在桌面 WebView 里,也能跑在 Node 进程里(ADR-0059 D1「只换 brain 宿主,保留两平面」)。这带来一个几乎被埋没的事实:**"一台远程机器上的完整 Cognia" 已经能被立起来,并且它对外说的就是 mobile 客户端说的同一套协议。**

具体已建好、可原样复用的东西(证据见 §2):

- **远端进程**: `cognia-server serve` 绑 `0.0.0.0:27890`,HTTPS + 自签证书 + 指纹锁,master-key 强制,起 companion API + WS 终端 + 事件流 + sidecar + brain。**它本身就是"远程主机上的 Cognia"。**
- **数据面**: `rpc::dispatch` ~150 命令白名单,被 HTTP `_rpc`、WebRTC、ACP、A2A **同构命中**,同一套能力门。含完整 git 瓷层、`fs_*_workspace`、`terminal_exec`、chat、external-agent、skills、plugins、memory、twin、workflow。
- **交互式终端**: `/ws/v1/terminal` 在无 WebView 的无头进程上**照样跑**(handler 不吃 `AppHandle`)。
- **执行面**: `ExecBackend` 三实现(Local / Docker container / Kubernetes),`COGNIA_EXEC_BACKEND` 选。
- **客户端传输**: `CompanionTransport` 目标可注入、每 call 复读;把它指向 `https://<remote>` 或 SSH 转发出来的 `https://localhost:<port>`,**379 个 `transport.call` 站点零改动**。
- **配对/鉴权**: pair/device/service 三 scope JWT + 指纹 pin + deny-list + control-allow-list,**含带外(非扫码)配对入口**(粘贴 `cgnp2\|` 载荷 / 6 位码)。

### 1.2 缺口的真实构成(小而具体,不是"造个 SSH")

| #   | 缺口                                                                                                                                                | 大小  | SSH 是天然填法?                     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ----------------------------------- |
| A   | **桌面缺"外向连一台远程 Cognia"的模式** —— 桌面硬接 `TauriTransport`,没有任何路径指向远程 companion。**这是唯一的架构级缺口(单一全局 transport)。** | 中    | 否(接线,缝已在)                     |
| B   | `codeserver_*` / `lsp_*` **不在 `rpc.rs` 白名单** —— 远程 code-server / 远程 LSP 打不出去                                                           | 中-大 | 否(加服务端臂)                      |
| C   | 无头下 Dexie/Zustand 支撑的 **bridge 臂**(workflow/twin/team CRUD)需连着 brain 才不 503                                                             | 小    | 否(跑 `COGNIA_BRAIN_ENTRY`)         |
| E   | **向远程机器 provision/bootstrap** —— 没有代码 SSH 过去装+起 cognia-server,今天全靠手动 docker/k8s                                                  | 中    | **✅ SSH 唯一真需要的地方**         |
| F   | **无头远程主机的 WAN 可达** —— WebRTC 对无头**不可用**(§2 F9),只能走 routable / cloudflared / SSH 转发                                              | 小-中 | **✅ SSH 隧道 fallback 的真实价值** |
| G   | 连**永不跑 Cognia** 的裸主机开 shell(生产机/路由器)                                                                                                 | 中    | **✅ 唯一"SSH 作一等终端传输"**     |

> **原以为的缺口 D(带外配对入口)已证伪** —— 它已存在(§2 F8),降级为"复用现成逻辑、在桌面露出"。

### 1.3 因此:SSH 的定位

- **数据面上,对桌面↔桌面 SSH 是冗余的**(WebRTC + cloudflared 已覆盖)。
- **但远程开发的目标机是无头 dev box**,而 **WebRTC 对无头不可用**(F9,已验证 + 有注释)。所以到达一台无头远程机,reach 只有 routable/reverse-proxy、cloudflared 隧道、或 **SSH `-L` 转发** 三条 —— SSH 在这里**不冗余**。
- SSH 的三个真实角色:**provisioning(E)、无 cloudflared 时的隧道(F)、连非-Cognia 裸主机(G)。** 全部是 v2 及以后。

**v1 应该完全不碰 SSH** —— 先把已建好的远程 API 外向接起来(R0–R4),用手动填 baseUrl + 现有 cloudflared 到达,就已经能"本地桌面驱动一台你手动起好的远程 Cognia,跑终端/文件/agent"。

---

## 2. 已核实的事实清单

> 行号截至 2026-07-17。**按符号重新定位,别按行号。**

### F1. `cognia-server serve` = 远程主机上的完整 Cognia,绑 `0.0.0.0`,master-key 强制 [CONFIRMED]

`src-tauri/src/bin/cognia-server.rs`:

- :92 doc「Binds 0.0.0.0:<port>」;:408 `server::spawn_server(port, false, tls, shared)` —— 第二参 `false` = 非 loopback-only;:415 `"HTTPS listening on https://0.0.0.0:{}"`。:406 注释「binding to loopback in a server context defeats the purpose」。
- :192 master key 从 `COGNIA_MASTER_KEY(_FILE)` 取,**无则 fatal**,keyring 禁用。
- 默认端口 `companion_api::server::DEFAULT_PORT`(:89)= **27890**(:94)。

**复用**: 整个 `run_serve` 引导 + `spawn_server` + TLS + graceful-shutdown。**新建**: 引导层零。

### F2. RPC 数据面是严格白名单,多入口同构 [CONFIRMED]

`src-tauri/src/companion_api/rpc.rs`:

- `POST /api/v1/_rpc/{name}` → `rpc_handler` → `dispatch(name, …)` 的单 `match name`;非 `KNOWN_COMMANDS_SET` 成员在进 state 前 404。
- 三张能力门: `READ_ONLY_COMMANDS`(:576 起)、`CONTROL_COMMANDS`(:617 起,需 `control_allow_list`)、`SERVICE_ONLY_COMMANDS`(需 `scope==service`)。门在 `rpc_handler`(:1073)与 `dispatch`(:1260)**两处都跑**,每个传输同构受门。
- `fs_read_workspace_file`(:396,READ_ONLY)、`fs_write_workspace_file`(:397,CONTROL :693)、`terminal_exec`(:412,CONTROL :709)**均已在白名单** —— 远程可达。

**复用**: 整份 ~150 命令 + 五 WS 端点。**新建**: 目录内零(除 R5 要加的 `codeserver_*`/`lsp_*`)。

### F3. 交互式 PTY 在无 WebView 的无头进程上照样跑 [CONFIRMED]

- `src-tauri/src/companion_api/server.rs:265` `.route("/ws/v1/terminal", any(ws_terminal::ws_terminal_handler))` —— **无条件挂载**,与 `/ws/v1/events`(:260)同级;:342 `app_handle: None` 是无头装配。
- `ws_terminal.rs:600-609` 文件内注释明写: `spawn_session_with_sink` 只要一个路径,「**without an `AppHandle`(this handler runs inside the axum server)**」。`spawn_session_with_sink`(`crates/cognia-terminal/src/session.rs:463`)签名不带 `AppHandle`。

> ⚠️ **别和 SERVER_BACKED 矩阵的「无 pty」混淆**(headless-full-parity F14 踩过这个坑): 那里的 `pty` 指**工作流节点能力 / 可见终端标签页**;这里说的是**远程 client 打开 host 上的 PTY**,是两回事。远程交互式终端属于后者,**今天就通**。

**复用**: `/ws/v1/terminal` + `ws_terminal_handler` + `spawn_session_with_sink` + 5min 断线重连/回放。**新建**: 服务端零。

### F4. 客户端 `Transport` 目标可注入、每 call 复读;单一全局 [CONFIRMED]

- `lib/tauri/transport-companion.ts`: 构造器 `opts: { configProvider?: () => CompanionConfig \| null }`(:288),`this.config()` = `configProvider() ?? loadCompanionConfig()`(:295);`call`/WS-open 每次都 `this.config()` 复读(:314, :590, :648, :773)。→ **换 `baseUrl` 无需重建实例;SSH 转发端点 `https://localhost:<port>` 直接可吃。**
- `lib/tauri/transport-instance.ts:39` `export let transport = pickTransport()`(单例);:46 `setTransport(next)` 是**替换**;`pickTransport`(:23)桌面永远 `TauriTransport`。
- **先例**: CLI/headless brain 已用 `new CompanionTransport({ configProvider })` + `setTransport`(见 `cli/dist/.../cli.mjs` 构建产物 `configProvider` 实例化)。

**复用**: `CompanionTransport({configProvider})` 第二实例范式 + `CompanionConfig`。**新建**: 见 R0 —— 桌面同时要本地+远程时,单一全局是唯一真限制([OPEN-1])。

### F5. 379 个 `transport.call` 站点全部传输无关 [CONFIRMED]

- `lib/files/workspace-fs.ts`(`fs_*_workspace`)、`lib/terminal/remote-api.ts`(`terminal_*`)、`lib/git/commands.ts`(`git_*`)等,**无一硬编码本地后端**,全部 `import { transport } from "@/lib/tauri"` 后调用。远程/本地取决于哪个 transport 活着 + 服务端门。

**复用**: 全部调用站点(加远程目标对它们零改动)。**新建**: 无。

### F6. `ExecBackend` 三后端已存在 [CONFIRMED]

`crates/cognia-external-agent/`: `trait ExecBackend`(exec_backend.rs:121)、`LocalProcessBackend`(:142)、`ContainerBackend`(container_backend.rs:337)、kube(kube_backend.rs,`k8s-exec` feature);`COGNIA_EXEC_BACKEND`(container_backend.rs:50)选。**这本身就是"把 agent 跑到别的算力上"。**

### F7. external-agent host seam 已抽象 [CONFIRMED]

`lib/ai/agent/external/agent-transport.ts`: `supportsExternalAgents() = isTauri() \|\| isHeadlessHost()`(:24);文件头(:10-11)明写 headless brain 走 `CompanionTransport → R11 service-scope RPC arms`。`spawn/send/kill/status_external_agent` 是 SERVICE_ONLY 臂。

**复用**: 这条缝就是 R4 的接入点。**新建**: 让它认得"远程 host"(第三种 host)。

### F8. 带外(非扫码)配对入口已存在 —— 缺口 D 证伪 [CONFIRMED]

`components/mobile/pair/pair-step.tsx`: QR/手动粘贴 tab + 6 位码 tab;`decodePairPayload`(`lib/qr/pair-payload.ts`)吃 `cgnp2\|` 载荷或裸 pair JWT;`redeemPairCode(baseUrl, code)`(pair-api.ts:105)POST `/api/v1/auth/pair/redeem-code`。测试佐证 `pair-step.test.tsx:64`「Paste the full cgnp2 payload or the raw pair JWT」。

**复用**: `redeemPairCode` / `redeemPairJwt` / `decodePairPayload` / `CompanionConfig` 落盘 / `recent-servers.ts`。**新建**: 仅把这套 UI 逻辑在**桌面** attach 语境露出(今天只在 mobile shell)。

### F9. 🔴 WebRTC WAN 桥是桌面 Tauri 专属 —— 无头远程主机拿不到 [CONFIRMED]

`src-tauri/src/companion_api/signaling/dispatch.rs`: :99 注释「this path is always Tauri-hosted (ADR-0059 R5)」;:100 `let host = DispatchHost::Tauri(app)`;:210 才 `rpc::dispatch(...)`。`SignalingHub` 只在桌面 `lib.rs` `.manage()`(mod.rs:75 起),`cognia-server` bin 从不装配它。

**后果(计划关键)**: 够到一台**无头**远程 dev box,**WebRTC 不可用**。reach 只剩:routable/reverse-proxy(已有 `deploy/compose/Caddyfile`、k8s ingress)、**cloudflared 隧道**(`tunnel.rs`,但需 server 侧起)、或 **SSH `-L` 本地转发**(R6)。→ 这正是 SSH 隧道**不冗余**的证据。

### F10. codeserver / lsp 完全不在 companion RPC —— 缺口 B [CONFIRMED]

阳性对照: `grep -e "codeserver" -e "lsp_" src-tauri/src/companion_api/rpc.rs` → **0 命中**;**同一次 grep** 在 `src-tauri/src/codeserver/PHASE2_AGENT_DRIVE.md:142` 找到 `codeserver_agent_open`(证明词存在、工具在工作)。codeserver 命令是 **Tauri 命令**,不是 companion RPC。`lsp_*` arm 根本不存在。

**新增一个 companion RPC arm 的代价(headless-full-parity F4,本计划复核)= 5 触点**: `KNOWN_COMMANDS` → `SERVICE_ONLY_COMMANDS`/门 → `dispatch()` match 分支 → `docs/api/mobile-companion-api.openapi.yaml` → `spec_parity.rs`(双向 CI 门,漏一边 CI 红)。两者均已确认存在(`docs/api/mobile-companion-api.openapi.yaml`、`src-tauri/src/companion_api/spec_parity.rs`)。

### F11. 桌面生产路径无任何外向 transport —— 缺口 A [CONFIRMED]

`grep "new CompanionTransport\|setTransport(" lib/ components/ app/ hooks/`: `transport-instance.ts` 只在 Capacitor / web-companion 用 `CompanionTransport`;`components/settings/.../*-config.tsx` 的 `setTransport` 是**同名的连接器/MCP 传输模式局部 setter**(阳性对照:它们 `onValueChange` 到 `McpTransport`/`TransportMode` 枚举,非全局 transport)。→ **桌面硬接 `TauriTransport`,今天没有任何外向路径。**

---

## 3. 工作项总览

| #      | 工作项                                                       | 阶段 | 依赖          | 性质             | SSH? |
| ------ | ------------------------------------------------------------ | ---- | ------------- | ---------------- | ---- |
| **R0** | 桌面外向"连接远程 Cognia"传输模式 + 主机注册表 + 配对 UI     | 0    | [OPEN-1]      | 🔑 keystone,接线 | 否   |
| **R1** | Reach 层:手动 baseUrl+指纹 → 复用现有 cloudflared / routable | 0    | R0            | 接线             | 否   |
| **R2** | 远程交互式终端(picker 加 remote-companion 目标)              | 1    | R0,R1         | 几乎免费         | 否   |
| **R3** | 远程文件 / 编辑器(workspace-fs 已远程可用;LSP 暂本地降级)    | 1    | R0,R1         | 接线             | 否   |
| **R4** | 远程 agent(agent-transport seam → 远程 host)                 | 1    | R0,R1;协调 C3 | 接线 + 协调      | 否   |
| **R5** | 远程 code-server + 远程 LSP(`codeserver_*`/`lsp_*` 提 RPC)   | 2    | R2;[OPEN-2]   | 🔴 重活          | 否   |
| **R6** | SSH provisioning + 隧道 fallback(装/起 cognia-server)        | 2    | R0,R1         | 新建(russh)      | ✅   |
| **R7** | 裸 SSH 终端到非-Cognia 主机                                  | 2    | —             | 新建,独立可选    | ✅   |

**顺序要点**: R0 是一切的地基,且 R0 前必须先拍 [OPEN-1](单一全局 transport 怎么解)。v1 = R0→R1→R2/R3/R4(可并行)。R5/R6/R7 全是 v2+,互相独立。

---

## 4. 详细工作项

### R0 — 桌面外向"连接远程 Cognia"传输模式 🔑

**问题**: 见 F11。桌面硬接 `TauriTransport`,无法把 `transport.call` 指向一台远程 Cognia。这是唯一的架构级缺口。

**复用(既有)**:

- `CompanionTransport({ configProvider })` 第二实例范式(F4,`transport-companion.ts:288`)—— CLI 已这么用。
- `CompanionConfig` 落盘 + `recent-servers.ts`(多服务器记忆,capped 5)。
- 配对逻辑 `redeemPairCode` / `redeemPairJwt` / `decodePairPayload`(F8)。
- 能力门/指纹 pin(`pinnedFetch`、`serverFingerprint`)全部照旧。

**新建**:

- 一个"远程主机注册表"数据模型(host = 一份 `CompanionConfig` + 标签)+ 桌面 settings section(落在 `system` 组,紧挨 `companion`/`network`/`remote-control`,复用 `FILL_HEIGHT_SECTIONS` 主/从范式)。
- 桌面版配对 UI(把 mobile `pair-step` 的粘贴/6 位码逻辑搬到桌面语境)。
- **解决单一全局 transport(见 [OPEN-1])**: 二选一 —— (a) 一个 `RoutingTransport`,按"当前活动 host"路由到本地 `TauriTransport` 或某个远程 `CompanionTransport` 实例;(b) 保持全局 = 本地,远程走独立持有的第二实例(agent/terminal 等按 host 显式取 transport)。**这一步是 R0 的核心技术决策。**

**验收**: 桌面上填入一台手动起好的 cognia-server 的 baseUrl+6 位码 → 配对成功 → `transport.call("git_status", …)` 打到远程并返回远程仓状态;本地功能零回归。

---

### R1 — Reach 层(v1 只做手动 + 复用 cloudflared)

**问题**: 见 F9。无头远程主机 WebRTC 不可用;v1 不引入 SSH,那怎么到达?

**复用(既有)**:

- routable / reverse-proxy 部署(`deploy/compose/Caddyfile`、k8s ingress+cert-manager)—— 用户自备 URL。
- cloudflared 隧道编排 `src-tauri/src/companion_api/tunnel.rs`(quick + named)+ `lib/connectivity/tunnel-resolver.ts` —— **但注意这是 server 侧起隧道**;远端 cognia-server 上起 cloudflared 得到公网 URL,桌面侧填该 URL + 指纹。
- `connection-strategy.ts:buildCandidates`(tunnel 是一等候选)。

**新建**: v1 仅需"桌面手动填 baseUrl + 指纹"路径(配合 R0 的粘贴配对)。**自动隧道留给 R6。**

**验收**: 远端(routable 或 cloudflared)+ R0 → 桌面在公网/跨网到达远程 Cognia。

---

### R2 — 远程交互式终端 ✅ 几乎免费

**问题**: 想在远程 dev box 上开交互式终端跑命令。

**证据**: F3 —— `/ws/v1/terminal` 无头已通,`RemoteTerminalSession`(`lib/terminal/transport-ws.ts`)已是把 `https→wss` 指向 `CompanionConfig` 端点的现成实现。

**复用(既有)**:

- 服务端: `/ws/v1/terminal` + `spawn_session_with_sink` + 断线重连/回放(F3)。
- 客户端: `RemoteTerminalSession`(transport-ws.ts)+ `configureCompanionEndpointResolver`(端点解析器)+ 全套 xterm UI / dock / 分屏 / 补全 / 历史。
- 能力门: `device_allowed_for_terminal` = `control_allow_list::global().is_allowed(device_id)`(rpc.rs:861 / ws_terminal 侧)。

**新建**:

- `lib/terminal/pick-transport.ts` 的 `TerminalTransportKind` 加一个"remote-companion"目标(或直接复用 `"ws"` arm,把 `CompanionEndpoint` 指向远程 host)。
- `spawn-orchestrator.ts` 对应 case —— 若复用 `ws` arm + 重指端点解析器,**可零新 session 子类**。

**验收**: 远程 host 上开一个终端标签页,跑 `ls`/`git status`,断网 5min 内重连回放不丢。

---

### R3 — 远程文件 / 编辑器

**问题**: 想用 Monaco 打开、编辑、保存远程机器上的文件。

**复用(既有)**:

- `lib/files/workspace-fs.ts`(`fs_list/stat/read/write/create/delete/rename/copy_workspace_*`)—— 已传输无关(F5),文件头注释明写"同 wrapper 在桌面与 paired/remote client 都工作"。
- 服务端 `fs_*_workspace` 已在白名单,写走 CONTROL 门(F2)。
- `use-project-editor.ts` / Monaco / `registerProjectWorkspace`。

**新建**:

- 让 Project Editor 的 `ProjectRoot` 能标记"远程 host + 远端绝对路径",文件 I/O 走远程 transport。
- **LSP 暂降级为本地**(远端 LSP 在 R5)—— UI 上诚实标注"远程 LSP 未接"(i18n 双语)。

**验收**: 打开远程仓的文件、改、存,回到远程终端 `git diff` 能看到改动。

> **[OPEN-2]**: 远程编辑要不要真远程 LSP?若 Monaco + workspace-fs + 本地降级 LSP 够用,R5 可整体不做。

---

### R4 — 远程 agent

**问题**: 想让 external agent(Claude Code / Codex)在远程机器上、对远程代码跑。

**复用(既有)**:

- `agent-transport.ts` 的 `isTauri() \|\| isHeadlessHost()` seam(F7)+ R11 service-scope RPC 臂(`spawn/send/kill/status_external_agent`)+ `external-agent://*` 事件(over `/ws/v1/events`)。
- `ExecBackend` 三后端(F6)—— 远端可选 local/container/k8s 隔离。
- 沙箱载体(`cognia-external-agent-launcher`、cwd jail、env scrub)。

**新建**:

- 让 `agent-transport.ts` 认得"远程 host"作为第三种 host(经 R0 的远程 transport 走 service-scope 臂)。
- **协调 headless-full-parity 的 C3**(external-agent-initializer 抽取,ADR-0059 T-A10)—— 那让远端 brain 真的能驱动 acp-client;**本项依赖其完成**,不重复做。

**验收**: 在远程 host 上 spawn 一个 Claude Code,让它改远程仓一个文件,事件流回本地 UI,改动落在远端磁盘。

> **注意 [CONFIRMED]**: bridge 臂(workflow/twin/team CRUD)在无头下需连着 brain 才不 503(缺口 C)。若远程开发 v1 只要 terminal/fs/git/chat/agent,**不跑 brain 也行**;要 workflow/twin 面板才需 `COGNIA_BRAIN_ENTRY`。

---

### R5 — 远程 code-server + 远程 LSP 🔴 重活(可选)

**问题**: 见 F10。`codeserver_*` 是 Tauri 命令、不在 companion RPC;`lsp_*` arm 不存在。所以 Pro-IDE(浏览器版 VS Code)和真远程 LSP 都打不到远端。

**复用(既有)**: `lib/codeserver/client.ts`(已是 `transport.call` 的传输无关 client)、`src-tauri/src/codeserver/`(process/webview/download,`PHASE2_AGENT_DRIVE.md` 已有 Phase 2 设计)。

**新建(代价明确)**:

- 把 `codeserver_*`(+ 新 `lsp_*`)提升为 companion RPC:每个命令走 **F10 的 5 触点**(`KNOWN_COMMANDS` + 门 + `dispatch` match + `mobile-companion-api.openapi.yaml` + `spec_parity.rs`)。
- 远端 LSP host(远端 cognia-server 内跑 LSP,结果经 `lsp_*` 臂回传)—— **这是本计划最重的一块,是 VS Code Remote-SSH 的量级**。

**验收**: 远程仓在桌面 Monaco 里有真远程补全/跳转;或远程 code-server webview 可用。

> **仅在 [OPEN-2] 判定"要真远程 LSP"时才做。** 否则 R3 的本地降级 LSP 收尾。

---

### R6 — SSH provisioning + 隧道 fallback ✅ SSH 真正登场

**问题**: 缺口 E/F。今天"在远端把 Cognia 立起来"全靠手动 docker/k8s/apt;且无 cloudflared、无 routable 时没有到达手段。

**复用(既有)**:

- `cognia-server` 二进制全套 + 子命令 `pair`(打印 `cgnp2\|<base64>` 载荷)/ `issue-service-token` / `rotate-master-key`。
- Docker/k8s manifest(`Dockerfile.cognia-server`、`deploy/compose/`、`deploy/k8s/`)、`deploy/runner/install-agents.sh`。
- secret_store(SSH 密钥/口令作**新命名空间**塞进现有 AES-256-GCM 单主密钥模型,零新 keyring item;见 [OPEN-5])。

**新建**:

- SSH 客户端(**`russh`**,新 crate)+ 主机密钥 TOFU/known_hosts([OPEN-5])。
- provisioning 编排: SSH 进机器 → 传/装二进制或 `curl`/`apt` → 起 `cognia-server serve`(systemd/nohup 生命周期)→ 注入 master-key → 跑 `cognia-server pair` 取配对载荷 → 回交 R0。
- SSH `-L` 本地转发管理: 把远端 `27890` 转成本地 `https://localhost:<port>`,喂给 R0/R1(F4 已证实 `CompanionTransport` 直接可吃)。

**验收**: 对一台只装了 sshd 的裸 Linux dev box,一键 provision → 桌面自动配对 → R2/R3/R4 全通。

> **最大坑 [OPEN-4]**: 远端二进制**版本对齐**(VS Code-Server 那个问题)—— 桌面升级后如何检测/升级远端 `cognia-server`。这条决定 R6 的运维复杂度。

---

### R7 — 裸 SSH 终端到非-Cognia 主机(独立、可选)

**问题**: 缺口 G。连一台**永不跑 Cognia** 的机器(生产机、路由器、跳板机)开 shell。今天只能在集成终端里手敲 `ssh`(`lib/claude/permissions/interactive-command.ts:122` 把它归类 `REMOTE`,零一等公民建模)。

**复用(既有)**: 全套终端 UI / 回放 / host profile 落盘范式;secret_store 存密钥/口令。

**新建**: 一个新的 `BaseTerminalSession` 子类,驱动 SSH PTY channel(russh,与 R6 共享 SSH 连接原语);host profile 数据模型 + settings。**这是唯一把 SSH 当一等终端传输的部分。**

**验收**: 存一个 SSH host,一键连上开 shell,凭据入 secret_store,断线回放可用。

---

## 5. [OPEN] 决策项(需人拍板,别默默替它做)

- **[OPEN-1] 单一全局 transport 怎么解**(R0 前提): `RoutingTransport`(按活动 host 路由)vs 全局保持本地 + 远程走独立第二实例。前者对调用方透明但要改 transport 层;后者简单但 agent/terminal 等要按 host 显式取 transport。
- **[OPEN-2] 远程编辑要不要真远程 LSP**: 要 → R5 重活(每命令 5 触点 + 远端 LSP host);不要 → R3 的 Monaco + workspace-fs + 本地降级 LSP 收尾,R5 整体不做。
- **[OPEN-3] 安全姿态转变**: 向外 SSH + 桌面持有远程 device-jwt + 远端绑 `0.0.0.0`,是姿态改变(当前连 `GIT_SSH_COMMAND` 都在沙箱 env 黑名单)。master-key 强制 + 指纹 pin + control-allow-list + 单次 pair-jwt 能兜住,但**需 ADR 级论证**。注意 `git status` 显示 `sandbox/protected.rs`、`sandbox-launcher` 正被改动,别与之打架。
- **[OPEN-4] 远端二进制版本对齐策略**(R6): 检测/上传/升级远端 `cognia-server` 的模型 —— R6 运维复杂度的主要来源。
- **[OPEN-5] SSH 主机密钥信任 + 凭据存储**: TOFU/known_hosts 模型;SSH 密钥/口令的 secret_store 命名空间(`com.cognia.ssh` / `<host>`,复用现有单主密钥,**不新造 keyring::Entry** —— 见 `.claude/rules/rust.md`)。

---

## 6. 与既有计划的关系(避免重复)

| 计划                                        | 它负责                                                                 | 本计划的关系                                                                                                                    |
| ------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **`2026-07-16-headless-full-parity.md`**    | 让**远端 cognia-server 能力完整**(IM 连接器、能力探测认无头、调度常驻) | **上游依赖**。它把远端做强,本计划把客户端**外向连上**远端。R4 依赖其 C3(external-agent-initializer 抽取)。**两者互补,不重叠。** |
| `2026-07-16-tui-external-agent-hosting.md`  | 本地 CLI/TUI 托管外部 agent(local 子进程)                              | 复用其 host-seam 概念,但本计划目标是**远程** host。                                                                             |
| `2026-07-16-tui-gui-linkage-remediation.md` | 同机两 shell 的 cli-bridge 联动(loopback-only)                         | 明确 `cli_bridge` 是 loopback-only、`companion_api` 是 device-jwt/LAN —— 本计划走**后者**外向扩展,不碰 cli_bridge。             |
| ADR-0059 / 0061                             | 云部署 / 无头 brain / 跨设备执行的既有决策                             | 本计划在其两平面架构上建"桌面→远程"客户端。                                                                                     |

---

## 7. 分期建议(落地顺序)

- **v1(纯接线,零 SSH,最快能真跑起来)**: [OPEN-1] 拍板 → **R0 → R1 → R2 / R3 / R4(可并行)**。产出: 桌面驱动一台手动起好的远程 Cognia,跑终端 / 文件 / agent。
- **v2(SSH 登场,自动化)**: **R6**(provisioning + 隧道 fallback)。把"手动起远程 Cognia"变一键。
- **v3(可选)**: **R5**(真远程 LSP / code-server,若 [OPEN-2] 要)、**R7**(裸 SSH 终端到非-Cognia 主机)。

**建议先只承诺 v1**,并在动 R0 前把 [OPEN-1] 与 [OPEN-3] 落成一份 ADR(下一个可用编号,中英双份 `docs/content/docs/{en,zh}/adr/`)。
