---
title: "0175：RPC 面只有一种语法、一种错误、一个版本"
description: "每条 companion 命令都命名为 <resource>.<verb>，资源来自声明的资源树，动词来自封闭词表。每个失败都是同一份 RFC 9457 problem 文档。一个契约版本号说明客户端是按哪份契约编译的。白名单仍是安全边界，但改由契约生成而非手写两遍，输出 schema 从产生它们的 Rust 类型派生。"
---

# ADR 0175：RPC 面只有一种语法、一种错误、一个版本

**状态：** 已接受
**日期：** 2026-09-09
**修订：** ADR-0013（命令清单）、ADR-0171（CLI 说的是协议本身）
**相关：** ADR-0059（无头大脑）、ADR-0090（agent 命令的规范名）、ADR-0143（设备控制台三态）、ADR-0153（确认由宿主取得）

## 背景

companion RPC 面是每个 Cognia 宿主客户端都要说的那一套 API：大脑走回环服务面的 `POST /internal/_rpc/{name}`，配对的手机、浏览器扩展和 CLI 走 DPoP 的 `POST /api/_rpc/{name}`。今天生成的规范里有 673 条具体的 internal 操作和 544 条设备可达操作，`protocol/companion-commands.json` 共 1,328 条描述符。

它是一条一条长出来的，从来没有什么东西把整体约束成一个形状。2026-09-09 的审计发现以下问题，全部在代码里核实过。

1. **没有命名语法。** 动词有时在前（`get_close_behavior`），有时在后（`automation_settings_get`），有时没有（`browser_pages`）。同一块看板挂在两个前缀下（`agent_task_*` 与 `team_task_*`）。单复数前缀并存（`skill_` 与 `skills_`、`connector_` 与 `connectors_`）。表示"停止"的词有四个（`_stop` 20 处、`_cancel` 11 处、`_abort` 9 处、`kill` 4 处）。`status` 出现 44 次、`state` 8 次，两者之间没有规则。CLI 索引按第一个下划线拆分名字推导 `group` 和 `action`，于是 `agent_task_cancel` 被归到 `agent` 组、动作叫 `task-cancel`。
2. **至少七种错误信封。** `api.rs` 序列化 `{error: {code, message, requestId, retryable, details}}` 并称之为规范。`middleware.rs` 序列化扁平的 `{code, message, requestId}` 并称之为统一。`rpc.rs` 的 `RpcError {code, message, retryable}` 没有 request id。Lark 入口一处回 `{error: "x"}`，另一处回 `{status: "error", error: "x"}`。排空态回纯文本。回执持久化的是 `{httpStatus, error}`。有一个错误码 `MEDIA_NOT_FOUND` 是大写。
3. **四套分页词汇。** `limit` 17 条、`offset` 10 条（在 `*_chunk` 家族里它同时表示字节偏移）、`cursor` 6 条、`before` 1 条。`session_list` 同时收 `limit` 和 `offset`。
4. **同一条线上两种参数大小写。** arm 同时接受 `session_id` 与 `sessionId`，CLI 索引为每个这样的字段打印"Also accepted as"，bridge 固件文档写明 sync 载荷是 snake_case 而消息载荷是 camelCase。
5. **五个版本计数器。** `HEADLESS_CONTRACT_VERSION` 是 1（宿主 catalog 的 schema 版本），清单写 `schemaVersion: 2`，bridge 帧协议是 3，Agent SDK RPC 协议是 2，其余 `protocol/*.json` 都是 1。大脑在 `hello` 里发的 `contractVersion` 并不指向定义了它要调用的命令的那份文档。
6. **没有运行时发现。** 手机把全部 1,328 条描述符打进构建产物才知道自己能调什么。没有任何端点回答"这个主体在这台宿主上可以调用哪些命令"。
7. **手写的输出契约。** `protocol/companion-response-schemas.json` 有 661 条手打的输出 schema，没有任何 Rust 类型派生它们。一次根类型错配（`integration_ingress_poll` 返回列表，schema 说是对象）让每次 `cognia-agent serve` 启动时 Marketplace ingress 都 `500 contract_output_violation`，直到被发现。
8. **75 条请求 schema 是生成器从 Rust match arm 推断出来的**，`cli:api:check` 不在 `check-all` 里（尽管 ADR-0171 说 CLI 靠门禁保持正确），文档里写着 450 条命令、bridge v2、`Authorization: DPoP`，而代码是 661 条、v3、`Authorization: Bearer` 加一个 `DPoP` 头。

ADR-0013 在命令面约 40 条时选择了手写白名单而非代码生成，并写明超过约 150 条应当重审。ADR-0171 为客户端一侧援引了这一条款，从契约生成了 CLI 索引。宿主一侧从未重审。

## 决定

参照的业界经验是 Google 的 API Improvement Proposals（AIP-121 资源化、AIP-131 到 136 标准与自定义方法、AIP-151 长时操作、AIP-158 分页）、RFC 9457 problem details、Connect-RPC 的"每方法一条路径 + 一种错误"，以及 Kubernetes 与 MCP 的发现端点。没有任何一个被整套照搬。每一项分别回答上面八条发现中的一条。

### 1. 一种语法

wire 名是 `<resource>[.<sub>...].<verb>`。每段是小写 snake_case。动词永远是最后一段。

- `resource` 是 `protocol/companion-resources.json` 里的一条路径。名词用单数（`session.message`、`team.task`、`git.branch`）。
- `verb` 是 `protocol/companion-verbs.json` 里的一个词条，后面可以跟一个留在动词上的限定词（`set_bounds` 写成 `bounds.set`，但 `read_chunk`、`list_pending`、`navigate_back`、`install_from_github` 保留限定词，因为它们是副词性的而不是名词）。每个动词都有一行定义。标准动词是 `list`、`get`、`create`、`update`、`delete`。
- 被拒绝的动词给出替代词：`kill` 和 `terminate` 是带 `force: true` 的 `stop`，`abort` 是 `cancel`（`git` 下例外，那是领域词），`destroy` 和 `remove` 是 `delete`，`state` 是 `get`，`execute` 是 `exec`，`check` 和 `test` 是 `probe`。
- 一个意思一个词。`cancel` 结束一个会终止的生命周期（task、run、job、upload、operation、handoff）。`stop` 停止一个可重启的进程或服务。`interrupt` 停止当前回合而会话存活。`status` 读取生命周期或健康摘要，`state` 永远不是动词。`probe` 回答一个无副作用的是否问题。

最糟的几个案例在语法下变成什么：

| 之前 | 之后 |
| --- | --- |
| `get_close_behavior`、`automation_settings_get` | `app.close_behavior.get`、`automation.settings.get` |
| `agent_task_cancel`、`team_task_move` | `team.task.cancel`、`team.task.move` |
| `agent_send`、`claude_send`（ADR-0090 别名） | `agent.session.send`（一条命令） |
| `kill_external_agent`、`background_job_kill` | `external_agent.stop`、`background.job.stop` |
| `browser_pages`、`browser_new_page` | `browser.page.list`、`browser.page.create` |
| `list_external_agents`（桌面进程表）、`external_agent_list`（大脑名册） | `external_agent.process.list`、`external_agent.list` |
| `session_list {limit, offset}` | `session.list {pageSize, pageToken}` |
| `scheduler_create_task`（OS 调度器）、`scheduled_task_create`（宿主调度器） | `scheduler.system_task.create`、`scheduler.task.create` |

`protocol/companion-command-renames.json` 记录每个旧名、它的规范名，以及当两个旧名本是一个操作时哪一个存活（`merge`）。

### 2. 一份契约、一个版本

`protocol/companion-commands.json` 是命令契约，`contractVersion: 3`。每条描述符在 ADR-0013 引入的策略字段之外，新增 `resource`、`verb`、`arm`（Rust 派发字面量）、`pagination`（`none`、`page-token`、`byte-range`）和 `longRunning`。

`CONTRACT_VERSION` 只存在于这一个文件里。`contract-identity.ts`、生成的 Rust 表、CLI 索引、OpenAPI 的 `info.version` 和 `hello` 帧都由它生成或被断言与它相等。它在以下情况递增：按上一版契约编译的客户端可能发出宿主现在拒绝的东西，或误解宿主现在返回的东西，即命令被删除或改名、新增必填输入、删除输入字段、输出根类型改变，或 `Problem`、`Operation`、`Page` 形状改变。新增命令或新增可选字段只移动 `catalogHash`。

`BRIDGE_PROTOCOL_VERSION` 仍是独立的数字。它给大脑 bridge 的帧语法（`hello`、`event`、`respond`、`worker_attach`）定版，帧语法可以在命令零变化时改变，反之亦然。`hello` 同时携带两者。

同仓的大脑 bridge 继续在 `catalogHash` 不精确匹配时拒绝。配对设备只按 `contractVersion` 拒绝。商店里的手机包无法与桌面自动更新同步发布，若按哈希拒绝，"宿主加了一个可选字段"就会变成"手机无法配对"。同一契约版本内的偏差由每条命令的 404、410 和下面的 catalog 端点回答。

### 3. 一种错误

每个平面上的每个失败都是一份 RFC 9457 problem 文档，`Content-Type: application/problem+json`：

```json
{
  "type": "https://cognia.dev/problems/command_renamed",
  "title": "Command renamed",
  "status": 410,
  "detail": "session_list is now session.list",
  "instance": "/api/_rpc/session_list",
  "code": "command_renamed",
  "requestId": "…",
  "retryable": false,
  "details": { "replacement": "session.list" }
}
```

`code` 仍是 snake_case 字符串。`requestId` 等于响应头 `x-request-id`。`retryable` 表示原样重发是否可能成功。失败属于某个长时操作时带 `operationId`。这个类型放在叶子 crate `cognia-problem` 里，因为 `cognia-gateway`、`cognia-connectors` 和 `cognia-headless-contract` 都不依赖 `cognia-core`。`ExecutionError` 已经恰好带着这些字段，直接变成 `Problem`。`RpcError` 仍是 arm 内部类型，在平面边界转成 `Problem`。WebSocket、WebRTC 与 bridge 平面上的帧保留各自信封，错误成员换成 `Problem`。Lark 自己的 webhook 确认格式是外部协议，保持不变。

### 4. 一种分页、一种操作形状

`list` 动词收 `pageSize` 与 `pageToken`，返回 `{items, nextPageToken}`（AIP-158）。`offset` 与 `length` 保留给 `read`、`write` 动词上的字节 I/O，其他地方一律拒绝。`limit`、`cursor`、`before`、`page` 不再是这个面上的参数名。

分页令牌对调用方不透明。底层是 base64url 编码的 `o:<offset>`（按偏移分页的存储）或 `c:<cursor>`（按序号分页的存储），所以客户端永远不可能把一个平面的游标递给另一个平面。`pageSize` 可选且有上限（默认 50，最多 1000）。今天整体答案有界的 `list` 暂不接分页参数，仍整集返回；门禁对这些只报告，直到它们的 arm 迁移；但凡一个命令声称按令牌分页却还写着 `limit`、`offset`、`cursor` 或 `before`，门禁直接判失败。

`longRunning` 的命令以 `202 Accepted` 返回 `Operation {id, done, error?, result?, metadata}`，`GET /api/operations/{id}` 与 `GET /internal/operations/{id}` 返回同一形状。run、job、batch、delivery 各家族的动词统一为 `start`、`cancel`、`get`、`list`。

### 5. 发现

`GET /api/catalog` 返回 `{contractVersion, catalogHash, commands}`，按调用主体可调用的范围过滤，使用的是派发器同一个准入谓词，所以 catalog 永远不可能宣告派发会拒绝的东西。`GET /internal/catalog` 返回全部。`ETag` 是 catalog 哈希。`GET /api/whoami` 新增 `contractVersion`、`catalogHash`、`catalogUrl`。

### 6. ADR-0013 改了什么

白名单仍然是安全边界，仍然逐行审阅。但它不再手写两遍。`src-tauri/src/companion_api/generated/known_commands.rs` 由契约生成，携带 wire 名、arm、resource 与 verb、策略字段和改名表。`rpc.rs` 里的 `KNOWN_COMMANDS` 退场。`rpc_handler` 与 `dispatch` 把 wire 名解析成 arm 一次，再把 arm 交给现有的 `match` 分支，所以改名那天 516 个 arm 一个都不用动。这正是援引 ADR-0013"超过约 150 条应重审代码生成"的那一条。现在的面是 1,328 条。

输出 schema 从产生它们的 Rust 类型派生。每个 wire 类型上打 `schemars` 的 `JsonSchema` derive，一张注册表说明每个 arm 返回哪个类型，`companion-contract-emit` 二进制写出 `protocol/companion-response-schemas.json`。手写的根类型再也不可能与 arm 不一致。真正无形状的载荷（原始 PTY 帧缓冲）以写明的理由和负责人保持 opaque，其精确集合由测试钉死。

请求 schema 只来自契约目录或 Zod 契约。`runtime-inferred` 变成生成器硬失败。

### 7. ADR-0171 改了什么

两种授权模式不变。CLI 索引的 `group` 与 `action` 改由声明的 `resource` 与 `verb` 给出而不是拆名字，`cognia-agent team task cancel` 由构造保证正确。`cli:api:check` 进入 `check-all`。参数别名（"also accepted as"）随大小写规则消失：两个平面上所有输入字段都是 camelCase。

### 8. 硬切

旧名被拒绝，而不是保留别名。宿主对旧名回 `410 command_renamed` 并在 `details.replacement` 给出新名。一个 codemod 重写 `lib/`、`components/`、`app/`、`cli/`、`packages/`、`plugins/` 下找到的 1,174 处字面量调用点，`check-command-grammar` 拒绝任何残留字面量，动态派发器可用 `// command-rename-exempt: <reason>` 豁免。移动端壳、浏览器扩展和 CLI 都在本仓库，在同一组提交里一起改。

## 落地

工作分六批落地，每批可独立提交、门禁全绿。

| 批次 | 内容 | 钉住它的门禁 |
| --- | --- | --- |
| B0 | 本 ADR、契约 v3 文件、`check-command-grammar`（R2、R6、R8 强制，R1、R3 到 R5、R7 在各自批次前只报告）、`cli:api:check` 进 `check-all`、四处文档纠错 | `audit:command-grammar`、`audit:companion-command-manifest` |
| B1 | `crates/cognia-problem` 与单一错误信封 | `problem_surface.rs`：每个错误响应都是 `application/problem+json` |
| B2 | 生成的 `known_commands.rs`、`/api/catalog`、`/internal/catalog`、`contract-identity.ts` | `generated_table_matches_protocol_contract`、`device_catalog_equals_what_dispatch_admits` |
| B3 | `Page`、`PageRequest`、`Operation` 辅助类型、今天真正分页的 10 个 arm、以及 202 与两条 operation 路由统一改答 `Operation` 文档 | R4 对 page-token 命令上的旧分页参数名转为失败，`companion-paging.test.ts`、`bridged_paging_translates_the_wire_shape_and_wraps_the_legacy_answer` |
| B4 | 每个 arm 输出的 `schemars` derive、发射器、75 条缺失的请求契约 | `registry_covers_every_dispatchable_arm`、`emitted_catalog_matches_committed` |
| B5 | 改名硬切：名字变为点号形式，`CONTRACT_VERSION` 3 生效，codemod，文档 | R1、R7 转为强制，`companion-api:check` |

其余 `protocol/*.json` 仍带 `schemaVersion: 1` 作为文件格式标记。由重新生成它们的那一批分别收编进 `contractVersion`。

## 后果

- 知道一条命令的读者就知道其他每一条怎么拼。破坏语法的新命令先在 `pnpm audit:command-grammar` 失败，而不是先到评审人那里。
- 客户端只解析一种错误类型。每个失败都有 `requestId`，`retryable` 由宿主声明而不是从 HTTP 状态码猜。
- `transport.call` 变成有类型的：`call("session.list", {pageSize: 20})` 从生成的 `lib/tauri/generated/commands.ts` 知道自己的输入和输出。
- 过期的设备从 `contractVersion` 知道自己过期，可以显示 ADR-0143 要求的三态，而不是一条命令一条命令地收集 403。
- 工作量是真实的。约 95 处生产环境的 `json!(…)` arm 需要 struct，75 条请求契约需要手写，1,174 处字面量需要 codemod。opaque 数量、推断 schema 数量和字面量数量各自被钉住，只能下降。
- 有两条读起来像例外的决定是有意为之。`status` 在没有生命周期的资源上也允许，因为它是"健康摘要"的唯一用词，而 `state` 被拒绝，于是即便没有 `start`/`stop`，任意的二分也消失了。`fetch` 允许用于从远端来源取回，因为 `get` 的含义是"读本地记录"，这个区分对 `ocr.http.fetch` 和 `connector.attachment.fetch` 是承重的。

## 范围之外

Dify 的 `/v1/*` 兼容面和 gateway 的 `/v1/*` 面是外部协议，形状不变。2026-08-15 审计定下的事件通道目录保留 `scheme://path` 标识，向 `resource.event` 对齐留给未来的 ADR。Agent SDK RPC、ACP、A2A 的信封是各自的协议。bridge 帧语法保持协议 3。已挂载的 17 条 `/connectors` 与 `/integrations/lark` 路由已在 `docs/api/README.md` 里作为文档后续项跟踪。设备路由保持不带版本号。

## 曾考虑的替代方案

- **保留 snake_case，只强制动词位置。** 否决。改名无论如何都要发生，而扁平名字藏起了 `team.task.cancel` 让人一眼看见的资源边界。
- **设备按精确 catalog 哈希拒绝。** 基于上文商店包的论证否决。大脑 bridge 保留它，因为它同步部署。
- **保留手写输出 schema，加一个夹具测试。** 否决。`integration_ingress_poll` 事故里的夹具恰恰与 schema 一致、与 arm 不一致。
- **单一 `/rpc` 路径上的 JSON-RPC 2.0 批量。** 否决。每命令一条路径保留了按命令绑定的 DPoP `htu`、每请求一个幂等键、每命令一个 OpenAPI 操作，生成的规范、CLI 索引和 parity 门禁都建在这上面。
- **保留一个发布周期的别名。** 用户否决。所有客户端都在本仓库，带替代名的 `410` 是手机日志可以据以行动的拒绝。
