---
title: "ADR-0059 — 云部署：无头 Brain 与前后端分离"
description: "定义云部署策略：保持桌面经过验证的双平面分割（Rust axum 前门 + TS lib/Brain），只交换Brain主机（WebView →节点无头主机）。涵盖完整计划：现有服务的部署工程（CI部署、GHCR镜像、组合套件）、完成认知服务器无头二进制（BridgeTransport、无头引导注册表、Brain进程、秘密存储）、frontend/backend-separated Web访问、执行平面（sidecar + 通过ExecBackend抽象的外部代理CLIs）以及三层隔离模型（ADR-0028沙箱/工作区容器/租户）microVMs）。"
---

# ADR-0059 — 云部署：无头 Brain 与前后端分离

**状态**：已接受 — 阶段0–1已着陆，阶段2部分（2026-07-13;提议 2026-07-02）**作者：Max Qian + Claude

> **2026-07-18 附录**：ADR-0085增加了第二个选择加入的 T2 执行形态：每个迁移工作空间一个持久WorkspaceRuntime，托管重复的 external-Agent 子节点、其开发服务器和一个私有Playwright服务。一次性per-Agent `ContainerBackend`保持默认状态，不会被移除。客户端只能通过`cognia-server`访问浏览器;运行时和CDP端点保持私密。

> **实现状态（2026-07-13，`dev`）**：阶段0已完全落地——`deploy.yml`是真正的门禁部署工作流（P0.1），`images.yml` publishes/compile-checks所有四个GHCR镜像（P0.2），服务工作流也推送`dev`（P0.3），且组合套件存在调优后的seccomp配置文件（P0.4）。第一阶段（W1–W6）已落地：无头二进制监控Brain + sidecar，服务器秘密存储被env密钥化，`compose-e2e.yml`在CI中运行二级烟雾。从第二阶段开始，F2（Caddy ACME 前门）、F4（公共连接器 webhooks）和 F6（服务器持有的连接器运行时租约）已发布，此外还有 Logto OIDC 网关上的多用户认证。从第三阶段开始，`ExecBackend::Container`（R13，路桩+`docker-compose.t2.yml`）、其Kubernetes特色（`k8s-exec`功能——带有固定站点和PVC-subPath工作区的跑者舱，通过`tenant-template/runners/`选择加入），以及`deploy/k8s`的kustomize树（D9/T3）都存在。伴随的默认端口迁移到了**27890**（冲突碰撞），整个部署套件都在跟踪它。下面的“背景”部分描述了截至2026年7月2日的世界，保持原样。
**基于以下内容：ADR-0012（传输抽象）、ADR-0014/0015（伴随API代理、D阶段骨架）、ADR-0021（信令）、ADR-0025（统一订阅）、ADR-0028（沙盒）、ADR-0037（共享服务器）、ADR-0043（提供商执行）、ADR-0048/0049/0051（外部代理）、ADR-0054（本地多账户）

## 背景

Cognia本地优先：Next.js静态导出被三个壳消耗，**桌面是服务器**——移动端通过云火廊隧道（`lib/connectivity/connection-strategy.ts`）访问mDNS → WebRTC →。当前云计算情况：

- **两个独立服务**（`services/signaling-server`、`services/share-server`），各自发布一个axum二进制文件+一个Cloudflare Worker变体Dockerfile和一个示例fly.toml。CI测试了它们（clippy + ≥90% llvm-cov），但**没有部署任何东西**——`deploy.yml` Vercel支架已死（`DEPLOY_ENABLED: false`），服务工作流的推送只在`master`触发触发。
- **无头 companion 前门现已统一到 canonical 协议**：`src-tauri/src/bin/cognia-server.rs` 打开 SQLite app/SecurityStore 状态、自签名 TLS 与指纹，签发 `cgnp3` Owner/OIDC 载荷，把秘密写入加密 backend，并以 `app_handle: None` 提供 companion axum router。设备流量使用 P-256 DPoP 绑定 access token 与单次 socket ticket。
- **CLI（`cli/`）证明Brain运行无头**：`fake-indexeddb`序言（`cli/src/db/install-indexeddb.ts`）允许桌面Dexie代码在Node中运行;`setTransport(StdioTransport)`开的是同款sidecar;去跳出的 JSON 快照（`cli/src/db/{bootstrap,snapshot}.ts`）会在存储中持久存在。
- **frontend/backend接缝已经存在**：所有内容都流经`Transport { call, subscribe }`（`lib/tauri/transport-types.ts`），有五种实现方式（Tauri IPC / 伴随 HTTP+WS / WebRTC / 网页存根 / CLI stdio）。纯网构建会获得存根，但存根会拒绝所有调用。

有三个因素决定了建筑架构：

1. **`AppStore`涵盖2个表格;Brain拥有15+。** D阶段性状（`companion_api/store.rs`）有六种方法（sessions/messages CRUD）。`sync_registry.rs`宣传角色、技能、工作流程、 workflowRuns、twinProfile、插件、adapterInstances、设置、目标、回忆、mcpServers、conversationOverrides、小部件......支持Dexie V54+ 架构及其迁移历史。在Rust重写数据平面意味着要重新实现所有这些内容，加上TS-only业务逻辑（构建选项、PII 门禁、连接器、团队编排）——一个永久性的双模式漂移。
2. **三WebView桥段对传输无关。** `sync_bridge` / `desktop_messages_bridge` / `desktop_writes_bridge`遵循相同模式：发射`{request_id, …}`，Brain通过命令回答，一次性解决。只有传输（Tauri `Emitter` + 命令）是WebView-specific的;~45 RPC 处理器则不然。
3. **移动客户端已经是该协议的lib/-brained客户端。** Capacitor运行相同的`lib/`，本地解决`resolveSendOptions`，并远程调用伴随RPC。无头 Brain作为localhost客户端加入，浏览器作为远程客户端加入，协议本身不会改变。

## 决策

### D1 — 换掉Brain，保留前门

重复使用台式机经过验证的双平面分割，只更换Brain主机：

```
┌── cognia-server (Rust, PID 1) ────────────────────────────────┐
│ Front door: TLS · JWT · rate limit · audit · companion RPC     │
│             sync_pull · connector webhooks (public!) · push    │
│ Supervisor: spawns brain (as Tauri spawns the sidecar) ·       │
│             spawns sidecar · spawns external agents (ACP)      │
│ Fallback:   SqliteAppStore (sessions/messages, read-only       │
│             degraded surface when the brain is down)           │
└──────┬──────────────────────────────▲─────────────────────────┘
  BridgeTransport (stdio/WS)     CompanionTransport (localhost
  data plane: Rust asks the       + service token) control plane:
  brain for rows                  brain invokes Rust commands
       ▼                              │
┌── headless-host (Node brain) ───────┴─────────────────────────┐
│ Full @/lib business layer: build-options · PII gate ·          │
│ connector adapters · scheduler · workflows · twin · teams ·    │
│ sync source · ExecutionBroker                                  │
│ Dexie (fake-indexeddb + durability ladder)                     │
│ sidecar (Claude Agent SDK / AI SDK)                            │
└────────────────────────────────────────────────────────────────┘
```

与桌面严格同构：`WebView ↔ headless-host`、`Tauri IPC ↔ CompanionTransport(localhost)`、`app.emit bridges ↔ BridgeTransport`。一个业务代码库，一个协议，两个主机——没有分支。

### D2 — 两次缝隙抽象，同一走法重复两次

- **`BridgeTransport`**（Rust）：三桥的 `AppHandle.emit` 在一个特征后面，分别是WebView实现（现行行为，未变）和WS/stdio实现（无头）。RPC 处理器未被触碰。
- **`ExecBackend`**（Rust）：`external_agent/process.rs`的“spawn = local tokio process”假设被一个特征包围——`LocalProcess`（桌面 + 单容器云）和 `Container`（每个工作区运行者，后期）。ACP 是一个标准级的溪流;连接到容器的标准节点对TS `acp-client`是透明的。

协议保持，传输交换——无论哪种情况。

### D3 — Brain拥有数据;AppStore是回退，不是终点

无头模式下唯一的唯一事实来源是Brain的 Dexie（完整的 v54+ 架构），通过耐久性阶梯（见 W3）来维持。D阶段`AppStore`方向——将RPC 处理器重写为直接SQLite——**已拒绝为主路径**（上述事实1），仅保留为降级的只读接口。

### D4 — 执行平面对等性：sidecar与外部代理 CLIs

云能力 = 桌面能力减去硬件限制功能。两种执行路径均为：

- **sidecar**（Claude Agent SDK / AI SDK）：由Cognia服务器生成并监督，完全像`claude/sidecar.rs`在桌面上做的那样（探测准备，退后崩溃）。
- **外部代理**（claude-code / codex / opencode / cursor / cline / gemini）：TS编排（`lib/ai/agent/external/{manager,acp-client,env-builder}.ts`）已存在于`@/lib`中并调用`Transport.call("spawn_external_agent")`;Rust监督（`external_agent/` — `command_resolver`、`proc_group`、ADR-0049硬化）保持原状，支持`ExecBackend`。凭证通过统一订阅库的流程与桌面版（`env-builder.ts`）完全相同;Codex设备代码OAuth和Claude令牌粘贴对无头友好。

云端不可使用（degraded/hidden）：电脑使用、OCR、原生终端接入主机、桌面宠物、原生 Sqlite-VEC（使用ADR-0023的五个云向量后端）。

### D5 — 三层隔离，三层拓扑

| 层 | 威胁 | 机制 |
| --- | --- | --- |
| **L1** 工具执行（bash/python/plugins） | 一malicious/runaway 命令 | ADR-0028沙箱——在Linux上，泡沫包装 + seccomp + `net_proxy.rs`允许列表代理。已经建成;已经被automation/canvas/plugin-python/terminal吞噬了。 |
| **L2** external-agent workspace | 完全信任的开发代理仍然不应逃离其工作区 | 工作区边界：卷挂载（T1）→每个工作区运行容器（T2） |
| **L3** 租户 | 用户之间不能看到彼此的data/credentials | container/microVM硬边界（T3） |

拓扑阶梯：

- **T1 — 单一容器**（自主机，单用户）：container = 租户边界;L1 内侧的 bwrap;L2 的 workspace volumes。**抓到了**：Docker默认的seccomp配置文件会阻挡`CLONE_NEWUSER`，所以bwrap在库存容器内失败。在作曲套件中附带调优的安全合成配置文件（绝不`--privileged`）;一旦失败，沙盒本身就已经通过`UninstalledSandboxBackend`退化了。
- **T2 — 分体执行平面**：`cognia-server + brain`留在主集装箱内（桥桥紧密连接）;外部代理会迁移到通过 `ExecBackend::Container`（Docker/containerd API）生成的每个工作区运行容器（image = external CLIs + Git + Workspace Volume）。
- **T3 — 多租户**：每个租户在gVisor/Kata/Firecracker上一个T1/T2单元，按租户编排（K8s命名空间 + NetworkPolicy）。`lib/execution/broker.ts`是Brain面quota/fairness hook。如果T2的抽象是正确的，T3改变的是实现，而不是架构。

### D6 — 安全模型

- 浏览器客户端**无法→自签名指纹**，前门云端需要真实域+ACME TLS（反向代理，例如compose套件中的Caddy）。直连Capacitor指纹钉选依然有效。
- Brain通过专用的**service token**（有范围、环回机制）向本地主机认证认知服务器——从不对设备JWT。
- 无头 RPC 接口 `spawn_external_agent`-class 命令有**RCE-grade**：仅预设允许列表（无任意ARGV）、独立范围、完整审计跟踪。
- `remote_control`（47821）和LLM `gateway`（47823）保持仅回环威胁模型——从未暴露于容器之外。
- PII的涂黑门禁（`packages/redact/src/index.ts:hasNoLeakingPii`）位于Brain中，因此在移动后保持不变;在每个阶段发售前，请先通过PII审核审核确认门禁。
- 客户端秘密保持密钥环;**服务器端秘密通过密钥迁移到加密文件存储**（模式前例：`FilePushCredStore`），主密钥通过env/boot秘密。

### D7 — headless ↔ 桌面的能力等价

2026-08-15 新增。本 ADR 的本意始终是让云端主机与桌面近乎等价。一次清点（`pnpm audit:host-parity`，完整报告见 [主机能力等价审计 — 2026-08-15](/docs/audits/host-parity-2026-08-15)）确认：机制是完整的，往它上面的迁移大约只做了一半 —— 带宿主守卫的 154 个子系统中，仅 **14** 个是物理不可能；68 个未迁移，62 个是 UI 按主机判断，10 个是 seam 自身。

**唯一事实源。** `protocol/companion-commands.json` 对"某主机能到达什么"具有权威性。`lib/platform/capabilities.ts`（粗粒度的按平台基线，用于 UI 降级）与 `lib/platform/host-feature-manifest.ts`（按 feature 的协议协商）是派生视图，不得与之矛盾。三者曾在**两个方向**上漂移 —— `source-control.git` 被声明为 `tauri` 专属，而它的 RPC arm 根本没有宿主门禁；反过来 `capabilities.ts` 为 `headless` 声明了 `connector-runtime`，而 4 个 IM 平台在那里根本收不到消息。门的 E 类负责保持三者一致。

**UI 声明能力，而非主机。** 2026-08-15 完成。按主机判断的 UI 会在后端已等价之后仍把功能藏起来，因此 `components/settings/settings-nav-config.ts` 中的 `desktopOnly: true` 已移除：`NavItem` 现在携带 `requires: CapabilityId[]`——以 `capabilityAvailable` 语义求值（本地 ∪ 服务端提供，与 `CapabilityGate` 同一规则）——外加对应 `CapabilityGateProps.profiles` 的 `profiles: HostProfile[]`。沿用已有先例 `NodeCatalogEntry.requires` + `lib/workflow/runtime/capability-preflight.ts`。21 个分区全部迁移，云端伴生服务现已可达终端、源代码管理、连接、沙箱、LSP、工具、Webhook、网关、Pro IDE、工作区信任与订阅。

七个分区保留 profile 钉定，但原因分两类。桌面、侧边栏、companion、远程主机属于本地外壳界面——真实边界。ccswitch、hooks、fleet 是**过渡性**钉定：其渲染端路径是 Class A seam 绕过，直接裸调 `invoke`（`lib/claude/settings.ts`、`lib/ccswitch/client.ts`、`lib/tauri/fleet.ts`、`lib/claude/hooks/fleet-hooks.ts`），UI 会够到传输层根本到不了的后端。每处钉定的注释都点名了需先迁移的文件；它们是有明确去处的债，不是决定。

**已记录的物理边界。** 已成定论，不再讨论：系统托盘；桌面宠物的覆盖窗口；AX/UIA 自动化本体；划词工具栏与桌面选区感知；全局 OS 快捷键；生物识别；本地麦克风与屏幕捕获；系统剪贴板；技能录制器；`apple-vision` 与 `windows-media-ocr` 两个 OCR 后端（`tesseract`/`ocrs`/`paddle` 到处都能跑，且 `packages/ocr/src/registry.ts` 已经为 headless 精确减去了这两个绑定 OS 的后端）。

**两件不是边界的事。** OS 钥匙串不是差距 —— headless 通过 `cognia-secrets` 达到等价。computer-use 的 **consent** 也不是差距：`headless` 已带有 `notifications.remote` 与 `remote_notification_publish`，consent 请求可路由到已配对设备批准。只有自动化**本体**绑定桌面。

**错误方向。** `RpcError::headless_unsupported` 曾被双向使用：约 27 个 arm 意为"这需要桌面"，约 105 个意为"这是云端专属" —— 而后者回给桌面调用方的文案指向的是相反的主机。现在 `headless_host_required` 承载第二种含义，两个方向各说各的实话。

那 15 个既是云端专属、又是 `target=execution` 且开放 `http`/`websocket`/`webrtc` 的 arm（即配对手机在两种主机上都够得到），已有 11 个通过 `DispatchHost` 访问器变为 host-neutral（`exec_backend`、`agent_event_emitter`、`remote_spawn_policy`、`harden_spawn_config`、`plugin_runtime`、`vscode_plugins`），沿用 `sidecar_state()` / `api_keys()` 的模式。两点需要钉住：

- **远程 spawn 在两种主机上都走严格策略。** 桌面的 `validate_desktop` 放宽是因为本地 Tauri `invoke` 意味着有人坐在键盘前；网络可达的 arm 拿不到这个前提。而**约束**仍随主机 —— 桌面照其本地命令的做法把子进程包进 sandbox host。
- **4 个 `codeserver_*` arm 保持云端专属，这是对的。** 桌面的 code-server 是另一个子系统（`codeserver::embedded`，ADR-0088）；云端那个是固定生命周期 + 设备绑定中继，按设计"配对的桌面无法安装或升级它"。没有可分支的桌面实例；而降级为 `service` 会切断那些正当地在云端主机上驱动它的配对设备。现在 `headless_host_required` 会把这件事原原本本告诉桌面调用方。

**连接器运行时的单一所有者。** 同一账号跑两份运行时会把每个机器人拨号两次——每条入站消息被处理两次，每条回复被发送两次。可能的碰撞有三种，各自需要不同的守卫。同一桌面应用的两个 webview 由 Web Locks（按 origin 作用域）覆盖。**驱动**远程主机的桌面端由路由覆盖：`isRemoteHostActive()` 期间 `ConnectorBusProvider` 会拆掉本地运行时。剩下没被覆盖的是：桌面 webview 与挂在该桌面伴生服务上的 brain 进程（ADR-0078 的 CLI 桥拓扑）——两个守卫的命名空间不相交，互相看不见。

现在 `connectors_runtime_lease_*` 是绑定同一个 `ConnectorsState` 的所有参与者的唯一仲裁者。三处改动使其成立：

- 这些 arm 变为**主机中立**（`DispatchHost::connectors_state()`），并同时注册为 Tauri 命令——桌面 webview 说的是 IPC，够不到自己伴生服务的 HTTP 面。两条路径绑定同一份 managed state，因此只有一个槽位。
- 它们是 **`target: execution` / `capability: agent.run`**，而非 service 作用域。桌面端持有的是设备 JWT 而非服务令牌；若保持 service-only，最需要参与竞争的一方反而无法参与。
- 所有权在 owner-id 前缀中携带**优先级类别**（`brain:` / `desktop:`）。brain 可立即抢占存活的 desktop 租约；desktop 永不驱逐 brain；同类之间保持先到先得，以免两个云端副本在每个续约周期互相抢夺。没有抢占的话，恰好先启动的笔记本会让常驻进程每次被挡住一整个 TTL。无法识别的前缀归入 `desktop`（较低类别）——解析不了的 owner id 绝不能驱逐运行中的 brain。

该租约在**桌面端失败即放行**、在 **brain 端失败即拒绝**。够不到伴生服务的 brain 按定义就是一个未经仲裁的第二所有者；而桌面端的伴生服务面是可选的，调用出错的安装必须与守卫存在之前完全一样地启动——Web Lock 仍覆盖其自身的 webview。

仍未覆盖、且刻意不在本次范围内：桌面端**本地**路由，同时另一个无关的云端部署服务于同一批已同步的适配器行。两者对接的是不同的伴生服务，不存在共享槽位。要关掉它，就得让桌面端去拨一个它并未路由到的伴生服务——那是远超单 owner 守卫的行为改动。

**棘轮的切换。** `pnpm audit:host-parity` 以**只报告**模式交付：`scripts/gates/check-host-parity.mjs` 中 `ENFORCE_RATCHET = false`，使存量债不阻塞第一批偿还。该批落地后即转为硬失败 —— 该批定义为 connectors seam 迁移 + 那 15 个远端可达的 arm。有一个测试钉住当前值，使切换不可能是意外发生的；本句即是"缓冲期非无限期"的承诺。

## 计划

工作包按依赖排序。每个TS/Rust项都遵循仓库规则：共址测试、≥90%覆盖率、任意 UI 字符串的 i18n、常规提交;每个阶段以预检审计集结束（测试间隙、I18N、静态导出、Tauri-Rust、PII-门禁、布线）。

### 第0阶段 — 部署工程（独立，随时开始）

| # | 任务 | 关键文件 | 接受 |
| --- | --- | --- | --- |
| P0.1 | 用真实的、可选择加入的部署作业替换死掉的`deploy.yml`：`wrangler deploy`（两者皆Worker）+ `flyctl deploy`（均为axum），由GitHub环境+仓库 `DEPLOY_ENABLED`变量+秘密控制。 | `.github/workflows/deploy.yml`，服务 READMEs | 手动调度部署到暂存;叉子保持绿色，没有秘密 |
| P0.2 | GHCR图片发布在`signaling`、`share`、`cognia-server`标签上;编译检查`Dockerfile.cognia-server`在CI | 新`images.yml`;`Dockerfile.cognia-server` | `docker pull ghcr.io/...`三者都适用 |
| P0.3 | 修正服务流程推送触发器，使其包含`dev`;增加信令`worker-build` 产物验证;添加一个共享核心↔TS-Worker常量对等性检查（代码length/alphabet/limits从`cargo`测试中作为JSON输出，Worker视频断言） | `.github/workflows/{signaling-server,share-server}.yml`，`services/share-server/core/`，`worker/src/index.test.ts` | 两侧漂移都失败CI |
| P0.4 | docker-compose 自主机套件 v1：信令 + 共享 + 健康检查 + volume;将调优后的SECCOMP配置文件（允许用户）作为第一阶段的交付物包含 | 新`deploy/compose/` | `docker compose up` →都`/healthz`绿色 |
| P0.5 | 在`.env.example` + `env.d.ts`（现有缺口）中记录`NEXT_PUBLIC_SHARE_URL` | `.env.example`，`env.d.ts` | — |
| P0.6 | 文档网站托管（Cloudflare Pages）——可选，低优先级 | `docs/` | 公共文档URL |

### 第一阶段——无头 Cognia核心（战略构建）

| # | 任务 | 关键文件 | 接受 |
| --- | --- | --- | --- |
| W1 | **`BridgeTransport`特征**：抽象化三桥的发射侧;`WebViewBridgeTransport`（现今未变）+ `SocketBridgeTransport`（WS或标准Brain）。桌面行为完全没有变化;单独合并 | `src-tauri/src/companion_api/{sync_bridge,desktop_messages_bridge,desktop_writes_bridge}.rs`，新`bridge_transport.rs` | 所有现有的桥梁测试都通过了这两个 impl |
| W2 | **无头引导注册表**：将运行时 提供商的效果体（`companion-boot`、`desktop-sync-source`、`desktop-message-source`、`backup-scheduler`、`a2ui-dispatch`、连接器运行时、调度器、初始化器/*）提取到plain-TS `bootstrapHeadlessRuntimes()`中;提供商变成了薄薄的包装。桌面行为完全没有变化;单独合并 | `components/providers/**`，新`lib/headless/bootstrap.ts` | 桌面应用的行为完全相同;每个提取运行时都有无头烟雾测试 |
| W3 | **无头主机进程**：用`serve`模式扩展CLI包（重用`install-indexeddb`、快照sidecar引导）：连接`SocketBridgeTransport`（接听数据平面），使用带有服务令牌的本地主机`CompanionTransport` →（驱动控制平面），调用`bootstrapHeadlessRuntimes()`。耐久性 v1：写入时冲洗去反弹 + 退出hook + RSS 度量 | `cli/src/serve/`（新），`cli/src/db/bootstrap.ts` | `cognia-agent serve`端到端回答`sync_pull`，针对本地的认知服务器 |
| W4 | **认知服务器监督 + RPC扩展**：spawn/supervise Brain + sidecar（探测准备、崩溃撤退、镜像`claude/sidecar.rs`）;骨料`/healthz`;mint/verify Brain的服务令牌;在预设允许列表 + 范围 + 审计后方的无头 RPC 接口中添加`spawn/send/kill/status_external_agent`;提取 **`ExecBackend`**（仅`LocalProcess` impl） | `src-tauri/src/bin/cognia-server.rs`，`companion_api/rpc.rs`，`external_agent/{process,commands}.rs`，新`exec_backend.rs` | 杀 -9 Brain → 前门 服务 503 + 降级读组，Brain重启，客户端恢复 |
| W5 | **服务器秘密存储**：加密文件存储替换无头中的密钥环读取（订阅保险库、向量信用、连接器声明、共享上传秘密）;主键通过ENV;PII-gate审计重演 | `src-tauri/src/subscription/vault.rs`（后端特征），`companion_api/push_creds.rs`模式 | Codex + Claude-Code 的信件结算在一个没有 密钥环 的容器中 |
| W6 | **容器+烟雾**：`Dockerfile.cognia-server` slim（仅sidecar）/ full（外接CLIs预装+git）版本;通过 Seccomp 配置文件连接到 Compose 套件;E2E 烟雾：pair → chat turn （sidecar） → external agent turn → connector webhook in | `Dockerfile.cognia-server`，`deploy/compose/` | 烟雾剧本违背`docker compose up` |

**第一阶段退出标准**：手机与云容器配对，完成服务器端的完整聊天回合，桌面关闭。

### 第二阶段——Frontend/backend分离

| # | 任务 | 注释 |
| --- | --- | --- |
| F1 | Web 传输选择：浏览器构建使用当前 Headless 目标的 `CompanionTransport`；`/pair` 消费 canonical Owner/OIDC 载荷，生成独立设备与 signaling 密钥，并只在注册成功后提交加密 Browser Vault 状态 | 两种语言均完成 i18n；`static-export-auditor` 必须保持绿色 |
| F2 | 真实TLS故事：Caddy（ACME）在 compose 套件前端，连接 cognia-server;指纹固定只放在Capacitor路径上 | 文档 + 作曲 |
| F3 | 账户模型：将`HEADLESS_LOCAL_ACCOUNT_ID`与ADR-0054多账户隔离对齐;Brain + 前门 的每个账户范围范围 | T3的前提条件 |
| F4 | 连接器公开：通过前门的公开URL暴露的网络钩路由;取消云安装的隧道要求docs/UI | 最大的结构性胜利 |
| F5 | UI中的能力降级矩阵：传输为云伴侣时hide/disable桌面专用功能 | i18n;移动端已有按功能划分的能力标志——扩展，不分叉 |
| F6 | 连接器运行时所有权：激活远程目标时，桌面守卫会先停止本地运行时；桌面内多个 WebView 仍由 Web Locks 串行化；多个无头 Brain 进程则通过仅限 service token 的 `connectors_runtime_lease_{acquire,renew,release}` RPC 竞争同一个 Rust 宿主租约 | 使用单调时钟计算 15 秒 TTL、每 5 秒续租；竞争失败不启动，续租失败则立即停止所有连接器传输。OneBot 反向 WebSocket 的入站事件和出站 action 继续走统一的连接器事件/命令平面；Lark OAuth 回调使用不进入 replay、仅投递给持有租约的 `brain-local` service principal 的事件，同时保留桌面 custom-scheme 跳转 |

### 2026-07-31 网页双重 运行时 完成

第二阶段不再仅从`web`中选择行为，而非仅`tauri`。Web shell 现在一次激活一个账户范围的`RuntimeTarget`：

- `standalone` 在本地执行AI SDK聊天、浏览器安全工具、附件、记忆和 提供商 路由。
- `companion`解析已解锁浏览器Vault的加密凭证引用，将传输和同步绑定到该目标，只使用`HostRuntimeManifestV2`宣传的健康且已授权的操作。
- `legacy-readonly`保存了迁移前的未机密数据，而不允许将其写回任意主机。

目标元数据是基于账户范围的，而每个目标都有物理独立的 Dexie 数据库。切换后，停止订阅→激活数据库→重新绑定传输 →刷新manifest/sync;传输重新绑定失败会回滚激活指针。出站队列行同时携带`accountId`和`targetId`，且不会对其他目标重玩。浏览器机密（provider 密钥、设备私钥与 signaling 私钥）由 PBKDF2/AES-GCM Vault 加密，且永远不会存储在公共目标簿中。

公共导航和深度链接消耗了共享`SurfaceContract`注册表。因此，每条路由解析为可执行、远程、缓存只读、队列或显式局部恢复状态。主机构建ID仅用于诊断：兼容性通过协议范围和每个功能版本协商，未声明、不健康或未授权操作默认拒绝。

### 第三阶段 — 扩展（仅if/when多租户）

`ExecBackend::Container`（每个工作空间运行者）→每个租户单位，采用gVisor/Kata → K8s编排+`ExecutionBroker`-backed配额→可观察性，符合服务惯例（Prometheus `/metrics` everywhere）。

### 2026-08-02 —— 耐久性阶梯 v4/v5 已落地

`HeadlessDurabilityBackend`（`cli/src/serve/persistence/`）是持久化端口，三级实现，
由每账户的原子清单（`<home>/durability/<account>/backend-manifest.json`）选定当前档位；
清单缺失时回落到 `COGNIA_DURABILITY_BACKEND` 灰度开关，最后回落到 `snapshot-v3`。

| 档位 | 形态 | 崩溃窗口 |
| --- | --- | --- |
| `snapshot-v3` | 既有的按表 JSON 存储，去抖写入 | 一个去抖间隔 |
| `journal-v4` | 不可变检查点世代 + 追加式、带校验和、序号连续的事务日志 | 无 |
| `sqlite-v5` | Node 内置 SQLite（WAL、`synchronous=FULL`、`foreign_keys=ON`、打开时 `integrity_check`、文件权限 `0600`），存放通用的 库/表/键/值 行 | 无 |

- **提交点在哪里。** `installTransactionCapture` 在 Dexie 设置自己的 `oncomplete` 之前，
  先在 DBCore 事务上注册 `complete` 监听器，并在该监听器里同步追加 + `fsync`。因此
  只要事务对调用方 resolve，它就一定已经落盘。恢复回放处于抑制状态，绝不会被写入日志；
  若 Dexie 已经打开则直接拒绝安装，而不是静默失效。
- **SQLite 保持通用** —— 不引入第二套需要手工维护的 Cognia 模式（对应 D3）。迁移期间先写
  日志、再以同一序号写 SQLite；启动时补放 SQLite 落后的尾部，因此兼容窗口在任意时刻被打断都安全。
- **除 `finalize` 外不删除任何东西。** 迁移、恢复、回滚都只*新增*世代、回滚包与清单版本。
  `durability recover` 先落到新世代并校验，之后才允许激活；`durability finalize --confirm`
  是唯一的裁剪操作，并会报告它留下的回滚水位线。
- **一致性闸门。** 只有模式版本、表集合、行数、键集合与逐表内容哈希全部通过，才会提升后端；
  失败则保持原后端权威，并打印全部差异。

## 风险

| 风险 | 缓解措施 |
| --- | --- |
| Node 中的耐久性 Dexie（fake-indexeddb 在内存中；快照在崩溃时丢失最后几秒；全库序列化为 O(n)） | **2026-08-02 已解决** —— 阶梯已建成：`snapshot-v3` 去抖快照 → `journal-v4` 带校验和的事务日志（事务对调用方 resolve 之前先 `fsync`）→ `sqlite-v5` WAL 行存储，三者都位于 `HeadlessDurabilityBackend` 之后，并有一条经过一致性校验的迁移路径。仍需监控 Brain RSS：内存中的数据集依然是该路径的上限。 |
| `lib/` 运行时 CLI未被执行的残余`window`/DOM假设（连接器、调度器） | W2每抽出运行时能落下无头烟雾;故障接口在提取时，而非生产阶段 |
| BWRAP 内部库存Docker不可用（`CLONE_NEWUSER`被封锁） | 在Compose中交付调谐的Seccomp配置文件;通过`UninstalledSandboxBackend`的诚实贬低 |
| 出生阶级RCE 接口 RPC | 预设允许列表 + 专用范围 + 审计；通过带鉴权的 Companion/gateway 前门暴露 |
| Brain⇄前门版本偏斜（滚动容器更新） | 他们用一张图片发货;`/healthz`报道了两种版本;桥接协议携带一个版本字段 |

## 考虑的替代方案

- **A — 完成D阶段`AppStore`重写（Rust拥有数据）**：已拒绝为主路径——重新实现15+表+TS-only业务逻辑，采用Rust永久双模式漂移。作为退化回退 接口被保存。
- **B — 容器中的无头 WebView/Electron**：服务器容器中的GUI 运行时;在资源、图像大小和稳定性方面都不合理。
- **C — 将Next.js变成SSR后端**：违反了`output: "export"`不变量，即三种运行壳都消耗一个静态导出。
- **D — 节点Brain自身生成外部代理**：丢弃`command_resolver`/`proc_group`/ADR-0049硬化并分叉监督逻辑。

## 后果

- 桌面和云共享一个业务代码库和一个协议;功能默认都存在于两者中。成本是一条硬性规则：**新的运行时副作用必须通过无头自助注册表注册，而非原始提供商效应**——通过接线审计执行。
- 移动端和网页客户端无需更改协议;网页构建最终成为一流的客户端。
- 配套RPC允许列表成为Cognia事实上的公共API合同;对它的变更现在具有兼容性分量（spec-对等性测试已经存在——可以扩展它们）。
- 直到耐久性阶梯v3之前，云安装受限于Brain内存;这对单租户自主机来说是可以接受的，必须在T3之前重新检查。
