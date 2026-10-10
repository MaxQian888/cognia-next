---
title: "0222 — 对话的文件是一个视图，分享文件是一次授权"
description: "每个对话拥有一个 FileSpace：从执行根、工作区根、上传文件和产物派生出的虚拟命名空间，可通过深链接直接定位。分享文件分两种：快照（ADR-0037 分享链接，新增客户端加密、分块上传的文件 blob）和实时授权（宿主持有、由文件网关强制执行的授权）。实时授权通过内置提供方或可选的 SFTPGo 提供方服务外部 WebDAV/SFTP 客户端，并通过新的宿主请求通道服务协作成员。组织文件分享策略、对话角色与授权三者取交集；智能体只能在自己的对话内、经用户批准后分享。"
---

# ADR 0222 — 对话的文件是一个视图，分享文件是一次授权

**状态：** 提议中——P0（FileSpace、链接、“对话文件”面板）、P1（附带文件的快照分享、文件分享策略、协作 `files.share`）与 P2（经 WebDAV/SFTP 的实时授权、SFTPGo 提供方、网络驱动器设置）已于 2026-10-10 交付
**日期：** 2026-10-10
**设计：** `docs/superpowers/specs/2026-10-10-conversation-filespace-and-sharing-design.md`
**相关：** [ADR-0037](./0037-public-share-links)（分享链接）、
[ADR-0065](./0065-agent-workspace-confinement-and-permission-unification)（工作区限根）、
[ADR-0111](./0111-managed-workspace-registry-and-bundle)（执行绑定）、
[ADR-0124](./0124-filesystem-viewer-registry)（宿主负责读取）、
[ADR-0144](./0144-workspace-as-the-unit-of-work)（工作区）、
[ADR-0149](./0149-a-person-is-not-a-device)（身份与协作）、
[ADR-0162](./0162-sftp-is-shell-equivalent)（SFTP，本 ADR 修订）、
[ADR-0200](./0200-files-is-a-view-that-keeps-what-you-keep)（文件页）

## 背景

一个对话的文件分散在执行根（托管 worktree、影子目录或项目检出）、工作区根、上传文件和产物里。没有任何地方把它们作为一个整体展示，没有链接能直接打开某个对话的文件，分享对话时无法附带文件；想让别人（或某个 WebDAV/SFTP 客户端）访问对话工作目录的一部分，只能交出一台已配对设备或一个 SSH 登录。

最初的方案要求存储 `ConversationFileSpace` 与 `StorageMount` 行、一个 `snapshot | live` 授权类型，以及每个对话一组 SFTPGo 虚拟目录。三个事实改变了方案形态：

- “哪些目录属于这个对话”已经有唯一权威：执行绑定（`SessionExecutionContext.execution.roots`，ADR-0111），回退到 `Project.roots`，由 `resolveSessionExecutionRoot` 解析。再存一份 FileSpace 就是第二个答案。
- 快照分享与实时访问不能共用一种记录。ADR-0037 的服务器不感知内容，且明确不做实时分享；实时访问需要在持有文件的机器上有一个在线权威。
- SFTPGo（AGPL-3.0）只能访问它自己的磁盘；协作服务器没有通往运行共享会话之宿主的通道；ADR-0162 禁止监听套接字。

## 决策

### 1. FileSpace 是派生的，从不存储

`lib/filespace/resolve.ts` 把会话投影为挂载点：`/workspace`（主执行租约，否则为工作区主根）、每个附加根对应 `/roots/<id>`，以及只读、以 Dexie 为存储的 `/uploads` 和 `/artifacts`。每个磁盘挂载点带有宿主路径、在 Docker 连接映射时的容器路径、`managed` 标记，以及带具名原因的状态（`no-fs-backend`、`host-offline`、`managed-missing-on-device`、`managed-deleted`）。不提供 `/shared`：绑定到 worktree 的对话不会同时暴露它所派生自的实时检出目录。

起草时的两个原因在实现 P0 时被去掉。容器运行时挂载的是宿主目录（绑定挂载，或宿主同样可见的卷子路径），因此重建或丢弃容器永远不会让挂载点离线，不存在 `runtime-ephemeral` 状态。运行在 ADR-0221 远程沙箱上的对话使用远程克隆；待该 ADR 提供可读取的按会话放置信息后，它将被标记为 `remote-sandbox` 并被实时授权拒绝。在此之前没有任何来源能产生这个原因，因此类型中也不包含它。

### 2. 链接可以定位对话的文件

桌面端为 `cognia://session/<id>?view=files&path=<FileSpacePath>&line=<n>`，应用内为 `/?session=<id>&view=files&path=…`；CLI 的 `open` 命令与之对应。未知的 `view` 值退化为仅打开对话。移动端打开对话并忽略文件字段。新增停靠面板“对话文件”，列出挂载点，并在现有工作区编辑器中打开磁盘挂载点。

### 3. 快照是一个附带文件的分享链接

扩展而非替换 ADR-0037。加密载荷增加文件清单；文件字节以分块 blob 形式上传到同一个分享码下。每个文件的密钥由片段密钥经 HKDF（salt 为 blob id）派生，每个分块的 AAD 绑定分享码、blob id、序号和总数，服务器仍然只看到密文。读取信封时返回的读取票据，让“阅后即焚”分享的文件在票据有效期内仍可下载。撤销或过期会删除其 blob。两套服务器实现（Rust 与 Worker）实现相同的 `/v1` 端点和常量。对话分享也不再输出无法解析的 `cognia-media:` 图片引用。

P1 的实际实现：每个 blob 的分块 IV 共享一个随清单携带的随机 8 字节前缀；带口令的分享以其 PBKDF2 输出作为 HKDF 输入，因此其文件同样需要口令。由于清单中的校验和位于信封内部，客户端在创建分享前先对每个文件计算哈希，上传时再次计算；两次之间发生变化的文件会被拒绝，并撤回未完成的链接。工作区文件通过新的分段读取宿主命令（`fs.workspace_file.read_chunk`）读取，因此每次上传只占用一个分块的内存。

### 4. 实时访问是宿主持有、由网关强制执行的授权

`crates/cognia-file-share`（platform 层）持有 `file-share.sqlite`：由 WebView 或 headless brain 推送的挂载表；带路径、权限（`read`、`download`、`write`）、受众（`credential` 或 `collab`）、状态和强制过期时间的授权；凭证（Argon2id）；持久化的认证退避；以及持久审计日志。每一次实时操作都经过同一个网关，按顺序检查：授权；挂载点（会话有效、挂载可用、指纹未变——否则授权变为 `stale`）；当前修订版本下的有效策略；通过 `cognia-files` 的路径限根；以及任何授权都无法覆盖的敏感文件底线。

P2 的实际实现：

- **一套命令面。** 十三个命令都在 `crates/cognia-file-share/src/rpc.rs` 中，桌面的 `#[tauri::command]` 外壳与伴侣 RPC 共用，因此已配对设备与 WebView 发送的参数完全相同。`file_share_activate`、`file_space_sync`、`file_share_policy_set` 仅限宿主（service 作用域）；读取需要 `host.observe` 并按令牌分页；授权变更是 `workspace.write` 控制命令；监听器与 SFTPGo 设置属于 `host-admin` 并需要二次验证。审计中，应用与 brain 记为 `owner`，已配对设备记为 `device:<id>`。
- **宿主主动拉取挂载表。** WebView 或 brain 会为有授权的对话推送挂载表，宿主也会在需要最新表时主动索取：每次创建授权时（已配对设备创建的授权由此绑定到当前路径）、恢复时，以及对每个仍有授权的对话每分钟一次（经桌面桥接的 `companion://filespace-mounts-request`；brain 会声明 `filespace` 能力）。拉取失败时保留上一份表，针对其他对话的回答会被拒绝。Dexie 中的文件以同样方式读取，每片最多 4 MiB。
- **哪些目录可以分享。** 磁盘挂载必须位于宿主愿意分享的根之下：桌面端是当前项目的根，或应用数据目录下的托管执行目录（绝不包括应用数据目录本身、`~/.claude` 或经对话框授权的路径）；headless 服务器则是 spawn 策略的工作区根。
- **账号由宿主决定。** 桌面端的账号会话在解锁时绑定已解锁账号、锁定时解除绑定；渲染进程只能确认该账号，不能指定其他账号，重复确认不会断开现有连接。headless 服务器在启动时绑定本地账号。
- **模块比设计稿少。** 维护任务（过期、策略复检、提供方重试队列、挂载表拉取）在 `service.rs` 中运行；没有 `provider.rs` trait，因为两种提供方保存的东西（密码哈希与已创建的 SFTPGo 用户）差异大于共性。

### 5. 提供方只负责协议，不决定访问

内置提供方在各自独立的监听器上运行 WebDAV（`dav-server`，Apache-2.0）和 SFTP（`russh` 加 `russh-sftp`，仅 subsystem——无 shell、exec 或转发），默认关闭，除非用户选择局域网或隧道，否则只绑定回环地址；所有操作都经过网关。SFTPGo 提供方为每个凭证创建一个 SFTPGo 用户，虚拟目录经配置的路径映射转换，并设置过期时间与禁止模式；SFTPGo 无法访问的路径会直接拒绝。SFTPGo 作为独立服务部署（`deploy/compose`），绝不打包进应用。

P2 的实际实现：监听器的暴露方式为 `loopback`、`lan`（WebDAV 使用伴侣证书走 HTTPS，SFTP 使用持久的 Ed25519 主机密钥）或 `tunnel`（由 cloudflared 子进程以快速或命名隧道承载 WebDAV）。每个凭证卡片显示可达地址、两种指纹，以及访达、Windows、rclone 与 OpenSSH 的连接步骤；无法访问的共享会说明原因（`listener_off`、`sftpgo_unconfigured`、`sftpgo_no_public_endpoint`）。监听器与隧道子进程在进程注册表中以 `fileShare` 子系统出现。失败的 SFTPGo 变更会排队重试，同时授权在本地保持已撤销。界面入口是“文件”面板中的“以网络驱动器共享”分区，以及“设置 → 连接 → 网络驱动器”；编排覆盖文件为 `deploy/compose/compose.sftpgo.yaml`。

### 6. 协作成员通过请求访问宿主

协作服务器为每个共享会话登记一个文件宿主（宿主令牌只存哈希），镜像受众为 `collab` 的授权，并新增请求表。成员的请求被存储，在现有会话流上通知，由宿主领取，经宿主网关再次鉴权后，以有界 JSON 或仅请求者可见、会过期的附件作答。headless brain 的“只读”规则仅为这个响应器放宽。

### 7. 权限是交集，策略只能收紧

有效访问 = 对话角色（共享会话以服务器为准，新增 `files.share`、`files.readLive`、`files.writeLive` 动作）∩ 挂载能力 ∩ 授权 ∩ 有效策略（本地设置 ∩ `org_file_sharing_policies`）− 敏感文件底线。创建者不能授予自己没有的权限。收紧策略会挂起超出新上限的授权。

### 8. 修订 ADR-0162：允许一个受限监听器

ADR-0162 对 SSH 的规则保持不变：不为 shell、exec 或转发监听套接字。文件分享监听器是有意的例外，因为它不等价于 shell：它验证按授权签发的凭证，只经网关提供该授权的路径，从不信任回环地址（隧道转发的请求来自 127.0.0.1），并且在用户启用之前保持关闭。

### 9. 智能体只能在自己的对话内分享，且需批准

`filespace_*` 内置工具族沿用产物工具的模式。`filespace_list`、`filespace_revoke_share`、`filespace_disable_webdav` 直接允许；`filespace_share` 和 `filespace_enable_webdav` 需要询问，不能被持久化为“始终允许”，仅在策略允许智能体分享时注入，并归类为 `external-send`。工具绑定到调用它的会话；工具结果中绝不包含密码。

### 10. 生命周期级联是显式的

`SESSION_DELETED` 没有订阅者，因此会话删除流程和路由后的归档写入直接调用级联。删除对话会撤销其实时授权并注销对应凭证；快照分享作为独立的加密副本保留，删除对话框会提示是否一并撤销。归档会挂起实时授权。分叉不复制任何授权。重新绑定或移动会使授权变为 stale。分享被撤销或过期时删除其 blob。

## 影响

- 一个解析器统一回答“这个对话有哪些文件”，供面板、链接、快照、实时授权和智能体工具共用。
- 快照分享保持零知识特性，可承载的大小提升到配置的单文件与单分享上限，而不再是总计 10 MiB。
- 宿主新增一个入站面：默认关闭、按凭证限定范围、限速、审计，并且每次操作都检查撤销。
- 协作服务器新增三张表和一组请求路由；从不登记宿主的会话保持现有行为。
- 分阶段交付（P0 FileSpace 与链接，P1 快照与策略，P2 实时授权与提供方，P3 协作成员、智能体工具与生命周期）。P3 交付且设计中列出的验证（WebDAV 客户端、SFTP 客户端、SFTPGo 往返）通过后，本 ADR 转为已接受。

## 已否决

- **存储 FileSpace 行。** 成为对话目录的第二个权威。
- **通过分享链接提供实时访问。** 破坏服务器不感知内容的特性，违背 ADR-0037 的非目标。
- **只用 SFTPGo。** 访问不到桌面文件，且其许可证使打包成为不可能。
- **把 WebDAV 挂进 companion 路由器。** 该路由器有 64 KiB 请求体上限，排空期间把 PROPFIND 当作写操作，并且信任回环地址。
- **复用 `ssh.files` 或 Control 授权。** 它们代表整台机器，而不是“这个对话的这些路径”。
