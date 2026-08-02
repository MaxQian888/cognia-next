---
title: "0100 — 统一模板平台"
description: "一个可移动、内容寻址的模板信封、一个按源代码分区的目录和一个生命周期服务，背后有十二个预存的“模板”概念，插件接缝则是哈希固定的预检计划。"
---

# 0100 — 统一模板平台

**状态：** 已接受 **日期：** 2026-07-30

## 背景

“模板”意味着十二个无关的东西，每个都有自己的存储、内置概念和导入路径，或者根本没有。其中六个由带有`isBuiltIn`标志的商店或Dexie表支持——Agent Team模板（`BUILT_IN_TEAM_TEMPLATES`）、子代理模板（`BUILT_IN_SUBAGENT_TEMPLATES`）、自定义模式（`MODE_TEMPLATES`）、工作流程模板、角色和技能。另外六个仅以硬编码列表或定制表格的形式存在：A2UI应用、目标模板、调度任务模板、提示预设、订阅预设和文档。

他们之间没有共享任何东西，缺席在每个案例中都一样：

- **没有身份，也没有版本。** 模板就是那一行。“将此团队更新到它来自的新版本模板”无法表达，因为没有资源记录具体化的来源。
- **没有便携式产物。** 没有办法把模板交给别人，因此没有需要签名、检查或装订尺寸的模板。
- **没有应用前的答案，比如“这会碰到什么”。**实例化意味着调用域的创建路径并了解情况。
- **一个插件只能贡献十二个贡献中的两个。** `PluginAgentTeamTemplateDef`和`PluginWorkflowTemplateDef`是两个无关的定制贡献形态，没有验证、来源，也没有自己的许可;其余十个领域完全没有贡献，接口。

## 决策

一个信封，一个目录，一个服务。`lib/templates/`拥有合同;域名保留了他们的作者。

- **`TemplateDefinitionEnvelope` 是唯一的可移植身份**，版本化为`cognia.ai/templates/v1`且内容寻址。`contracts.ts`拥有形状、规范字符串化、哈希创建及验证。发布按`id@version`标识，草稿按状态和修订的 `id`标注。内容寻址是让导入定义能够根据其“本质”而非来源来评判的。

- **两个领域层级，故意不等。** `TEMPLATE_FULL_DOMAINS`（agentTeam、工作流程、子代理、customMode好像、角色、技能）获得整个生命周期：将现有资源投射到载荷、前检、实例化、差异、更新、分离。`TEMPLATE_CATALOG_ONLY_DOMAINS`（a2ui、goal、scheduler、prompt、subscription、document）可以在同一目录中搜索，但各自保持独立的创建流程。六个完整领域已有可通过端口驱动的写入者;另外六个都有专门的创作路径，重新实现这些路径会以每个域名多一个不同作者的代价换取可发现性。

- **目录项目;它从不拥有。** `runtime.ts`将真实存储和Dexie写入者作为端口连接，因此实例化仍需经过`createTeam` / `createWorkflow` / `createCharacter` / ......遗留表保持其自身行的权威，并衍生目录条目，这避免了为同一资源创建两个写入者的过渡。

- **预检返回计划，且计划被哈希钉住。** `preflight` 提供绑定、操作、问题及定义`definitionHash`;`instantiate`拒绝了一个哈希值不再匹配的计划。这就是让插件接口安全的缝隙：`lib/plugin/api/templates-api.ts`保留未涂黑的计划，给插件一份敏感绑定ID被替换为`${kind}:bound`的副本，并要求插件返回计划ID。因此，插件既无法读取其绑定的资源ID，也无法呈现未预检的计划。

- **四个权限，实例化还需支付域名自身的费用。** `templates:read` / `:contribute` / `:instantiate` / `:library:write` 都在权限目录中。`templates:instantiate`此外，定义中声明的能力映射到其所暗示的域权限（`execution`和`tool` → `agent:control`、`filesystem` → `filesystem:read`等），缺少权限则阻碍计划，而不是在应用时失败。没有这种映射，`templates:instantiate`就会成为插件从未声明的功能洗白路径。

- **实例记录来源;绑定会留在设备上。** `templateInstances`保留全定义快照、内容哈希、绑定指纹以及一个`baseline` 载荷——使`diff(baseline, local, next)`和`planUpdate` / `applyUpdate`能够表达的合并基。`templateDeviceBindings`和`templateMigrationJournal`仅本地化，且故意不注册在`lib/sync`：绑定指定*这台*机器上的资源，journal行则是关于*该*设备已经转换了什么的声明。

- **迁移是日志式且幂级的，不是一次性的。** `bootTemplatePlatform`每个解锁账户运行，通过`LegacyTemplateSource`适配器转换遗留行，ID（确定性地从域名导出）加上NFKC-normalized源密钥。日志让重播安全且可`rollbackMigration`;没有它，第二次启动会重复部分第一次启动。

- **内置是每个启动的叠加层，不是迁移的行。** `refreshBuiltInTemplateOverlays`每次启动时重新投影发布的常量和`isBuiltIn` Dexie行到目录中，而不是复制到`templateDefinitions`。内置的内置软件必须随着应用版本移动;迁移后的副本会为用户首次启动的版本固定。

- **目录按源码划分。** `TemplateCatalog`每个源码ID（`plugin:<id>`，内置覆盖层，Dexie）存储一个映射，因此`removeSource` / `replaceSource`在插件卸载时恰好仓库一个贡献者的集合。平面映射会导致卸载一个插件要么会丢失定义，要么需要完全重建。

- ** 包是带有验证签名的硬压缩包。** `package.ts`压缩和扩展的大小、文件数量、路径深度和压缩比，固定邮编日期以便导出可重复，并在任何内容进入目录前，将每个定义和资产与清单的 sha256 进行核对。Ed25519 签名覆盖规范序列化的清单，但不包含自身`signature`字段——由于清单包含每个定义和资产的摘要，签名则涵盖了内容。

被`NEXT_PUBLIC_UNIFIED_TEMPLATE_PLATFORM`限制，默认开启。在`/templates`（模板工作室）以及Agent Teams页面、工作流程设置模板标签页和Discover中搜索。

## 后果

**信任通过密码学验证，但没有钉入密钥。** `signed-unknown` 这意味着字节与包中*包含的*公钥*匹配——但该密钥并不属于任何特定对象。`verified-publisher`是基于频道的优势（通过`source: "marketplace"`收到的签名包裹），而不是固定的发布商密钥。没有出版商注册，所以陌生人自签名的包裹和知名作者的包裹在市场层级以下无法区分。任何更强的作品都需要一个关键故事，而这故事还不存在。

**六个域在过渡期间携带两种表示**——其原始存储或表，仍为写者，以及衍生的目录投影。这就是不同时重写六条创建路径的代价，也意味着一个获得端口外新写路径的域名将默默停止被投影。

**两种遗留插件贡献类型存续，但被冻结。** `registerLegacyPluginTemplateCompatibility`项目`PluginAgentTeamTemplateDef` `PluginWorkflowTemplateDef`成`0.0.0-compat`未签名版本，使现有插件继续工作。它们没有被延伸;新的贡献会通过`templates:contribute`或模板包进行。

**Dexie v132 增加了五个表格。** 其中三个表携带便携投影，并以`lib/sync`注册，并拥有自己的处理器（`templateDefinitions`、`templatePackages`、`templateInstances`）;根据上述推理，两个带设备示波器的系统则不然。v133 被故意跳过——v132 是在一个并发会话同时对同一树进行未承诺工作时编写的，`schema.ts` 中的注释记录了原因。

**载荷类型必须是`type`别名，绝不能是`interface`。** 载荷必须满足`TemplateJson`，其对象臂是索引签名，TypeScript仅对对象字面类型别名推导出隐式索引签名。将一个`interface`宣布为会破坏`adapters.ts`、`legacy-sources.ts`和`template-studio.tsx`的分配，这正是`adapters.ts`评论用来防止重复出现的陷阱。
