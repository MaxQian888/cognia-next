# 插件独立加载调查 — 2026-10-05

## 结论与证据边界

当前系统有可工作的外部插件执行器，但「仓库里的插件」和「可以脱离主程序发布的插件包」还不是同一种交付物。内置加载路径绕过或补齐了外部加载必须面对的清单、入口、资源和信任问题；安装、发现、启用又由不同入口分别处理。因此不能把“内置时可用”视作“发布一个包后就能独立安装、更新、重启恢复”。

本次检查覆盖全部 67 个 `plugins/*/plugin.json`，以及桌面、浏览器/移动端和 standalone CLI 的构建、安装、发现、装载、贡献注册、更新与恢复路径。没有改动产品实现，没有安装插件到真实用户配置，没有联网发布或下载插件。共享工作区包含其他任务的未提交改动；本报告针对本地工作树，关键文件的最终哈希见 `source-snapshot.json`。

**实测确认的正面结果：62 个 frontend 插件全部可以在选择适当构建目标后生成独立 CJS，并通过真实 PluginLoader 的 fetch/eval 路径求值。** 其中 59 个通过通用 `platform: neutral`；Documents、Office、Presentations 需要 `platform: browser`。这里证明的是“编译和模块求值”，不包含 62 个插件的完整 `activate()`、真实权限批准、后台服务和功能 UI。

## 现状清单

| 类别                  | 数量 | 当前交付与发现方式                                                                                       |
| --------------------- | ---: | -------------------------------------------------------------------------------------------------------- |
| 生产前端静态内置插件  |   46 | registry 静态 import，随宿主 JS 分发；44 个 manifest.main 指向 TS/TSX，2 个指向已编译 JS                 |
| 生产前端资源内置插件  |    5 | Office、PDF、Documents、Presentations、Visualize；独立 CJS 文件，目录和 SHA-256 固定在宿主导入的 JSON 中 |
| 不默认注册的 frontend |   11 | 包含 1 个 E2E-only reference，其余是安装型插件或作者/测试示例                                            |
| 随桌面包预置的 Python |    2 | RepoWiki、Laya Guard；复制到插件目录后发现                                                               |
| 其他 native 示例      |    3 | 两个 Python demo、一个 WASM formatter demo，标为 dev-only                                                |
| 合计                  |   67 | 62 frontend、4 Python、1 WASM                                                                            |

5 个独立资源文件此前逐个核对为存在且 SHA-256 与目录匹配。它们的按需获取已经实现，但它们的发布目录仍是主程序构建产物；不能通过替换远端代码自由更新，因为校验哈希绑定主程序。

## 已确认的阻断和差异

### 1. 大多数内置插件尚未形成独立发行包

46 个静态生产插件中，43 个 `main` 是 `.ts`，1 个是 `.tsx`，仅 github-delivery 和 github-devin-bot 指向 `dist/index.js`。桌面安装目录路径只复制文件；`plugin_read_entry` 返回文本，随后 loader 按 CJS 求值，不负责编译 TypeScript/ESM。把 clipboard-tools 源码放入相同求值包装器，结果为 `SyntaxError: Cannot use import statement outside a module`。

GitHub/registry 的 `validate_no_build` 只检查入口文件是否存在，没有证明内容是可执行产物；一个存在的 `.ts` 文件可以通过这层检查，然后在装载时失败。

证据：[入口执行](/Users/bytedance/Project/cognia-next/lib/plugin/core/loader.ts:754)；[目录复制](/Users/bytedance/Project/cognia-next/src-tauri/src/cli_bridge/handlers.rs:1210)；[文件存在性检查](/Users/bytedance/Project/cognia-next/crates/cognia-plugin-runtime/src/github/installer.rs:299)。

### 2. 通用 CLI 构建会写回源码，而且浏览器插件构建目标不统一

Rust CLI 的 `run_esbuild` 以 `manifest.main` 作为输出位置，同时优先用 `src/index.ts` 作为输入。对于现有 `main: src/index.ts` 的内置插件，输入和输出重合。

在临时目录使用同样 esbuild 参数验证：构建成功，但原始 TypeScript 文件被 CJS 覆盖（`sourceOverwritten: true`）。**没有在真实插件源码上运行这条写入构建命令。** 因此迁移时必须先把源码入口和发行入口分开，不能直接批量执行现有 `cognia plugin build`。

通用 neutral 构建还不能直接处理 Documents、Office、Presentations 的浏览器依赖解析；切到 browser 后三者全部成功。PDF 的 worker 则需要额外构建 define 和资源，只有“bundle 能加载”仍不足以证明 PDF 功能可用。

证据：[CLI 输出路径](/Users/bytedance/Project/cognia-next/crates/cognia-cli/src/engine/frontend_build.rs:156)；[CJS 构建参数](/Users/bytedance/Project/cognia-next/crates/cognia-cli/src/engine/frontend_build.rs:140)。

### 3. 10 个内置插件的 JSON 清单缺少模块里实际声明的贡献

对每一个真实求值后的 bundle，调用生产 `findPluginManifestParityIssues` 与源目录 `plugin.json` 比较。下表 10 个有差异；内置 registry 会把模块 manifest 合并进 JSON，而外部加载会执行 `assertPluginManifestParity` 并拒绝漂移。

| 插件 ID                      | 差异字段                                                                                  |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| `cognia-agent-team-examples` | `subagents`, `agentTeamTemplates`, `sharedMemoryAdapters`, `balanceAdapters`              |
| `cognia-anthropic-skills`    | `skills`                                                                                  |
| `cognia-backend-refactor`    | `skills`, `characterPacks`, `subagents`, `agentTeamTemplates`, `workflowTemplates`        |
| `cognia-builtin-characters`  | `characterPacks`                                                                          |
| `cognia-work-mode`           | `modes`, `skills`, `subagents`, `agentTeamTemplates`                                      |
| `cognia-computer-use`        | `nativeAnthropicTools`, `subagents`, `agentTeamTemplates`                                 |
| `cognia-context-inspector`   | `contextPanels`, `webviews`                                                               |
| `cognia-deep-research`       | `skills`                                                                                  |
| `pagerduty`                  | `characterPacks`, `integrations`, `bots`                                                  |
| `zhihu-content-pipeline`     | `skills`, `mcpServerPresets`, `characterPacks`, `agentTeamTemplates`, `workflowTemplates` |

这不是“将来可能有问题”：同一份模块与同一份 packaged manifest 的比较已经复现。独立发布需要生成完整贡献清单；包含可执行对象的贡献还需要符合宿主的 handler/export 绑定方式，不能只对对象做 JSON.stringify 后假定行为保留。

证据：[内置合并](/Users/bytedance/Project/cognia-next/lib/plugin/core/browser-builtin-registry.ts:177)；[外部 parity gate](/Users/bytedance/Project/cognia-next/lib/plugin/core/manager.ts:3620)。

### 4. 修改 main 还不够，二级入口与资源必须同步打包

- cognia-anime-effort 的 `extensions[0].entry` 仍是 `src/index.tsx`，cognia-scheduler-tools 的 bot entry 仍是 `src/index.ts`。
- 内置路径的 `importPluginEntry` 会直接返回已经加载的整个模块 namespace，所以这些源码路径在内置模式下无需真的作为文件执行。
- 外部路径会读取 entry 指定的真实文件。仅生成 `dist/index.js`、只修改 main，会导致二级入口仍指向源码或缺失文件。
- CLI ZIP 打包默认只带 `plugin.json` 和 main，额外文件需要 `bundle_include`。上面两个插件、主题插件和 PDF 的当前清单没有这个字段；styles、图片、图标主题和 worker 不能由默认 ZIP 自动保证完整。
- game-worlds-theme 的资源根写死为 `/plugins/cognia-game-worlds-theme/`；多个主题的 icon 也是主程序 public 路径。anime-effort 使用 `/illustrations/cognia-anime-effort/operator.webp`。
- PDF 需要 `__COGNIA_PDF_WORKER_URL__`；缺失时读取 PDF 会明确报 worker asset unavailable。

宿主已经有通过 `plugin_read_entry_base64` 读取插件目录资源的 resolver，以及外部 styles 文件读取路径，可以复用。现有插件必须实际使用这些路径，才能把资源随包迁走。Tailwind 类在宿主构建时被扫描不等于未来新插件的 CSS 会自动生成；新增插件样式应作为发行包内容验证。

证据：[二级入口内置短路](/Users/bytedance/Project/cognia-next/lib/plugin/core/manager.ts:6193)；[ZIP 文件清单](/Users/bytedance/Project/cognia-next/crates/cognia-cli/src/engine/frontend_build.rs:188)；[PDF worker](/Users/bytedance/Project/cognia-next/plugins/cognia-pdf/src/pdf-engine.ts:94)；[图片路径](/Users/bytedance/Project/cognia-next/plugins/cognia-anime-effort/src/index.tsx:346)。

### 5. registry 安装成功与运行时发现之间缺少接线

指定版本的 registry 安装会调用 Rust 下载并原子落盘，然后签名校验、记录 origin，返回 success。但这条客户端路径没有调用 manager 注册/扫描，也没有建立 Dexie plugin row。UI 成功后调用的是 marketplace catalog refresh，不是磁盘插件扫描；该原生命令本身也没有发出目录安装使用的 `cli-bridge:plugin-installed` 事件。

聚焦探针用成功的 native download/signature 边界替身运行真实 JS marketplace 和 fake-indexeddb：返回 `success: true` 后，runtime store 和 Dexie row 都仍不存在；对缺失 row 调用真实 `setPluginConfig` 也没有建立 row。该结果解释了“下载成功，但插件不立即出现/配置丢失”的可达路径。此项没有做真实网络下载或点击 UI；探针的 mock 边界在 `marketplace-probe.json` 中注明。

本地目录安装有事件→扫描链，GitHub 的 manager 安装有注册链，更新器也有 commit→rescan→verify→reactivate 链；不能把 registry 初次安装的问题扩大成所有安装入口都失败。

证据：[安装完成路径](/Users/bytedance/Project/cognia-next/lib/plugin/package/marketplace.ts:1046)；[UI 安装后动作](/Users/bytedance/Project/cognia-next/components/plugins/marketplace/plugin-marketplace.tsx:233)；[catalog refresh](/Users/bytedance/Project/cognia-next/hooks/plugins/use-plugin-marketplace.ts:246)；[原生落盘](/Users/bytedance/Project/cognia-next/crates/cognia-plugin-runtime/src/marketplace.rs:691)。

### 6. 安装入口的支持范围和协议不统一

- 本地目录与 GitHub 可以交付编译后的 frontend；GitHub 不替插件执行 build。
- `Install WASM from file/URL` 的后端明确要求 `type: wasm`，不能把 frontend ZIP 送入这条通道。Rust CLI 自身另有 ZIP 安装路径，不能据此说所有 ZIP 安装都只支持 WASM。
- registry 的指定版本路径使用 tar.gz 下载解包。
- 不传 version 的 registry 分支以及 `PluginManager.installPlugin(source)` 仍向 `plugin_install` 发送 `{source, installType, pluginDir}`；实际 Rust 命令要求 `{pluginId, source, payload}`，返回的也是 snapshot 而不是前者假定的 `{manifest,path}`。即便补齐参数，该命令也只写 manifest 状态，不负责下载/复制完整包。
- 当前 marketplace 卡片和详情通常会传 version，所以这条旧协议问题是明确的分支缺陷，不是所有 marketplace 操作必然失败。
- browser/mobile 本地 profile 只扫描内置 registry，通常安装接口要求桌面。底层能 fetch JS 不代表产品已支持纯浏览器持久安装任意插件。配对客户端显示远端插件也不等于在手机本地运行。

证据：[旧调用分支](/Users/bytedance/Project/cognia-next/lib/plugin/package/marketplace.ts:998)；[真实 IPC 契约](/Users/bytedance/Project/cognia-next/crates/cognia-plugin-runtime/src/lifecycle.rs:1287)；[WASM 类型限制](/Users/bytedance/Project/cognia-next/crates/cognia-plugin-runtime/src/wasm/installer.rs:194)；[browser/mobile 发现](/Users/bytedance/Project/cognia-next/lib/plugin/core/manager.ts:2440)。

### 7. SDK 发布清单和宿主共享模块映射有一处漂移

`@cognia/plugin-sdk/api/pet` 已列在 package exports，但缺少 `PLUGIN_SDK_SUBPATH_LOADERS` 对应项以及宿主 tsconfig alias。两个现有一致性测试因此失败。外部包把这个已发布 subpath 留作 require 时，当前 loader 无法提供它。

现有 62 个 frontend bundle 没有依赖这个新 subpath，所以它们的求值通过不反证该缺口。`plugin:author-imports` 通过也只证明没有私有 import，不能证明所有公共入口都已在宿主实现。

证据：[SDK exports](/Users/bytedance/Project/cognia-next/packages/plugin-sdk/package.json:168)；[共享 subpath 表](/Users/bytedance/Project/cognia-next/lib/plugin/core/sdk-subpath-loaders.ts:42)。

### 8. 同 ID 的内置/磁盘副本按扫描顺序覆盖；卸载没有内置 tombstone

桌面先扫描 builtin，再扫描磁盘；store.discoverPlugin 按 ID 覆盖 manifest/source/path，不比较版本。正常扫描完成后磁盘副本生效。若磁盘扫描失败、清单被拒绝或签名校验失败，已写入的 builtin 副本会保留。聚焦 store 探针确认：local v2 后再次发现 builtin v1，记录回到 builtin v1。

这不等于“任何重启都会降级”：正常桌面完整扫描会再次让磁盘副本覆盖。问题是缺少明确、持久的来源选择/优先级，错误时可能回退；活跃实例仍缓存按 pluginId 存储，扫描本身不等于重装或切换运行实例。

前端 builtin 卸载会删除数据库/store 记录，但下一次 registry scan 又会发现并 install；没有对应删除标记。代码静态 import 也仍在宿主中。关闭插件的意图有持久化恢复逻辑，并已存在相关测试；关闭和真正移除发行内容是两回事。

证据：[扫描顺序](/Users/bytedance/Project/cognia-next/lib/plugin/core/manager.ts:2440)；[store 覆盖](/Users/bytedance/Project/cognia-next/stores/plugin-runtime/plugin-store.ts:297)；[卸载行为](/Users/bytedance/Project/cognia-next/lib/plugin/core/manager.ts:4459)。

### 9. Python 预置器按“版本不同”替换，不按已安装版本判定升级

seeder 只比较 localStorage marker 与 bundled catalog 是否相等，不读取当前安装包版本。版本不同就整体复制。临时依赖探针确认 marker 为 2.0.0、catalog 为 1.0.0 时仍会 seed；外部安装了更高版本也不会被这层检查保护。

同版本删除后 marker 尚在时不会立即重装；但新 bundled 版本到来或 marker 丢失会再次复制。若后续要让这些插件独立更新，需要明确“预置默认版本”与“用户安装版本”谁拥有目录。

证据：[预置复制策略](/Users/bytedance/Project/cognia-next/lib/plugin/distribution/seed-bundled-plugins.ts:136)。

### 10. Standalone CLI 与桌面加载语义不同

桌面 CJS evaluator 注入宿主共享 SDK/React；standalone CLI 的 `makeNodeFrontendImporter` 使用原生 `import(file://...?v=N)`。

在独立临时插件目录，直接调用真实 importer，确认：

1. CJS 包含 `require('@cognia/plugin-sdk')`，没有插件自身 node_modules 时失败为 `MODULE_NOT_FOUND`。宿主主包中存在 SDK 不会自动把它变成外部模块的共享实例。
2. CJS 第一次导出 version=1，文件改成 version=2 后再次调用 importer，结果仍为 1。URL 查询参数没有清除 CJS require cache。现有 importer 的三个测试只注入 fake dynamicImport 检查 URL，没有覆盖真实 CJS 缓存。

测量环境为本机 Node v26.5.0；没有验证其他打包 Node 版本或实际 CLI 发布包。此项不影响已经测试通过的 renderer fetch/eval 路径。

证据：[真实 Node importer](/Users/bytedance/Project/cognia-next/cli/src/plugin/node-importer.ts:21)；[CLI 注入入口](/Users/bytedance/Project/cognia-next/cli/src/plugin/plugin-runtime.ts:270)。

### 11. 已有独立发行案例，但不能据此推断所有内置插件就绪

`github-delivery` 有清单生成、CJS、ZIP 的专门构建实现；`github-devin-bot` 也已有 dist 入口。另有刻意不内置的技能、Pi 和订阅参考插件。这些说明独立交付不是空设计。

但 github-delivery 的已提交 `github-delivery-3.0.0.zip` 与当前源码不一致，现有产物一致性测试失败。迁移需要对发行物本身做验证，不能仅运行直接 import src 的插件单测。

证据：[github-delivery 发行构建](/Users/bytedance/Project/cognia-next/scripts/plugin/build-github-delivery.ts:41)；[产物一致性测试](/Users/bytedance/Project/cognia-next/scripts/plugin/build-github-delivery.test.ts:139)。

## 验证结果

- 全目录清点：67 manifests。
- 全 frontend 独立构建：62/62 在选择正确目标后成功；通用 neutral 59/62，其余 browser 3/3。
- 全 frontend 真实 fetch/eval 模块求值：62/62 成功；未执行全量 activate。
- packaged manifest 与 bundle manifest：10 个有差异。
- 本轮现有测试：14 suites，493 cases；490 通过、3 失败。失败为 SDK pet 映射/alias 两项、github-delivery ZIP 漂移一项。
- 自定义诊断：runtime inventory/store/seed 2 cases，registry install 1 case，最终均通过（测试断言的是观察到的现状，不意味着问题已修复）。registry 探针首次缺 IndexedDB，加入 fake-indexeddb 后重跑通过。
- 真 Node importer 和 esbuild 写入路径：在临时目录实测，临时目录已清理。
- 没有运行 coverage、全应用 lint/typecheck/build、Rust 全编译，未做全插件真实桌面 UI/重启/后台服务验证。报告不宣称生产安装闭环已通过。

## 后续实施顺序与验收条件

1. **先建立统一发行产物。** 分离 source entry 与 runtime entry；为每个插件选择 browser/node 构建目标；生成完整 JSON 清单；重写所有 entry；打包样式、图片、worker 等资源；确保 SDK/React 使用宿主共享实例。验收：只给发行目录即可读取所有声明文件，源码不被修改，manifest parity 为零。
2. **统一安装后的注册过程。** 复用已存在的 manager 注册/事务机制，把 native 落盘、来源记录、发现、配置持久化和激活串起来；修复旧 plugin_install 调用约定；明确 frontend/WASM/GitHub/registry 各种包的入口。验收：安装完成即出现在库里，配置不丢失，取消/失败保留旧版本。
3. **再替换静态 registry。** 保留轻量 catalog，明确预装、按需下载与用户安装的关系；定义同 ID 选择规则、卸载 tombstone、版本优先级和现有用户迁移。验收：主程序不 import 插件源码；卸载后重启不复活；外部升级后重启不退回内置版本。
4. **按不同类型做试点。** 先选简单工具，再选有 manifest 扩展的知乎/Work Mode、带 UI/图片的 anime/theme、带 worker 的 PDF、Python RepoWiki。每类都验证安装→显式信任/权限→启用→使用→禁用→更新→重启恢复→卸载。
5. **CLI 单独验收。** 对齐 SDK 注入/解析与 CJS 缓存策略；使用真实发布 Node 环境和主仓之外的插件目录，不能只测模拟 import URL。

不建议现在直接删除全部静态 import 或批量运行 `cognia plugin build`。先把同一个插件的“内置版本”和“发行包版本”行为对齐，再改变默认交付方式。

## 逐插件清单

表中“求值通过”仅指独立 bundle 被 loader 执行并返回 exports；不表示功能可用或安装验证通过。类型、入口、构建错误、exports 和 parity 字段详见相邻 JSON。

| 插件目录                         | 交付分类      | 当前 main       | 构建/求值              | 清单差异                                                                        |
| -------------------------------- | ------------- | --------------- | ---------------------- | ------------------------------------------------------------------------------- |
| `agent-team-examples`            | 静态内置      | `src/index.ts`  | neutral 构建、求值通过 | subagents, agentTeamTemplates, sharedMemoryAdapters, balanceAdapters            |
| `anthropic-skills`               | 静态内置      | `src/index.ts`  | neutral 构建、求值通过 | skills                                                                          |
| `browser-tools`                  | 静态内置      | `src/index.ts`  | neutral 构建、求值通过 | 无                                                                              |
| `clipboard-history`              | 静态内置      | `src/index.ts`  | neutral 构建、求值通过 | 无                                                                              |
| `clipboard-tools`                | 静态内置      | `src/index.ts`  | neutral 构建、求值通过 | 无                                                                              |
| `cognia-anime-effort`            | 静态内置      | `src/index.tsx` | neutral 构建、求值通过 | 无                                                                              |
| `cognia-appearance-demo`         | 静态内置      | `src/index.ts`  | neutral 构建、求值通过 | 无                                                                              |
| `cognia-arknights-theme`         | 静态内置      | `src/index.ts`  | neutral 构建、求值通过 | 无                                                                              |
| `cognia-azur-lane-theme`         | 静态内置      | `src/index.ts`  | neutral 构建、求值通过 | 无                                                                              |
| `cognia-backend-refactor`        | 静态内置      | `src/index.ts`  | neutral 构建、求值通过 | skills, characterPacks, subagents, agentTeamTemplates, workflowTemplates        |
| `cognia-bugfix-review`           | 非默认/示例   | `dist/index.js` | neutral 构建、求值通过 | 无                                                                              |
| `cognia-builtin-characters`      | 静态内置      | `src/index.ts`  | neutral 构建、求值通过 | characterPacks                                                                  |
| `cognia-character-seeds`         | 非默认/示例   | `src/index.ts`  | neutral 构建、求值通过 | 无                                                                              |
| `cognia-documents`               | 内置资源      | `src/index.ts`  | browser 构建、求值通过 | 无                                                                              |
| `cognia-game-worlds-theme`       | 静态内置      | `src/index.ts`  | neutral 构建、求值通过 | 无                                                                              |
| `cognia-genshin-theme`           | 静态内置      | `src/index.ts`  | neutral 构建、求值通过 | 无                                                                              |
| `cognia-goal-insights`           | 静态内置      | `src/index.ts`  | neutral 构建、求值通过 | 无                                                                              |
| `cognia-honkai-star-rail-theme`  | 静态内置      | `src/index.ts`  | neutral 构建、求值通过 | 无                                                                              |
| `cognia-laya-guard`              | 桌面预置      | `—`             | 未测 native runtime    | 未比较                                                                          |
| `cognia-material-icon-theme`     | 静态内置      | `src/index.ts`  | neutral 构建、求值通过 | 无                                                                              |
| `cognia-office`                  | 内置资源      | `src/index.ts`  | browser 构建、求值通过 | 无                                                                              |
| `cognia-pdf`                     | 内置资源      | `src/index.ts`  | neutral 构建、求值通过 | 无                                                                              |
| `cognia-presentations`           | 内置资源      | `src/index.ts`  | browser 构建、求值通过 | 无                                                                              |
| `cognia-python-demo`             | 非默认/示例   | `—`             | 未测 native runtime    | 未比较                                                                          |
| `cognia-python-runtime-demo`     | 非默认/示例   | `—`             | 未测 native runtime    | 未比较                                                                          |
| `cognia-rfc-toolkit`             | 非默认/示例   | `dist/index.js` | neutral 构建、求值通过 | 无                                                                              |
| `cognia-sandboxed-tools`         | 静态内置      | `src/index.ts`  | neutral 构建、求值通过 | 无                                                                              |
| `cognia-scheduler-tools`         | 静态内置      | `src/index.ts`  | neutral 构建、求值通过 | 无                                                                              |
| `cognia-scheduling-demo`         | 静态内置      | `src/index.ts`  | neutral 构建、求值通过 | 无                                                                              |
| `cognia-share-watch`             | 静态内置      | `src/index.ts`  | neutral 构建、求值通过 | 无                                                                              |
| `cognia-visualize`               | 内置资源      | `src/index.ts`  | neutral 构建、求值通过 | 无                                                                              |
| `cognia-work-mode`               | 静态内置      | `src/index.ts`  | neutral 构建、求值通过 | modes, skills, subagents, agentTeamTemplates                                    |
| `cognia-zenless-zone-zero-theme` | 静态内置      | `src/index.ts`  | neutral 构建、求值通过 | 无                                                                              |
| `computer-use`                   | 静态内置      | `src/index.ts`  | neutral 构建、求值通过 | nativeAnthropicTools, subagents, agentTeamTemplates                             |
| `context-inspector`              | 静态内置      | `src/index.ts`  | neutral 构建、求值通过 | contextPanels, webviews                                                         |
| `deep-research`                  | 静态内置      | `src/index.ts`  | neutral 构建、求值通过 | skills                                                                          |
| `e2b-sandbox`                    | 静态内置      | `src/index.ts`  | neutral 构建、求值通过 | 无                                                                              |
| `eval`                           | 静态内置      | `src/index.ts`  | neutral 构建、求值通过 | 无                                                                              |
| `external-agent-adapter-example` | 非默认/示例   | `dist/index.js` | neutral 构建、求值通过 | 无                                                                              |
| `external-agent-preset-example`  | 非默认/示例   | `dist/index.js` | neutral 构建、求值通过 | 无                                                                              |
| `figma-external-service`         | 静态内置      | `src/index.ts`  | neutral 构建、求值通过 | 无                                                                              |
| `github-delivery`                | 静态内置      | `dist/index.js` | neutral 构建、求值通过 | 无                                                                              |
| `github-devin-bot`               | 静态内置      | `dist/index.js` | neutral 构建、求值通过 | 无                                                                              |
| `impeccable`                     | 非默认/示例   | `dist/index.js` | neutral 构建、求值通过 | 无                                                                              |
| `kimi-subscription`              | 非默认/示例   | `dist/index.js` | neutral 构建、求值通过 | 无                                                                              |
| `ocr`                            | 静态内置      | `src/index.ts`  | neutral 构建、求值通过 | 无                                                                              |
| `pagerduty`                      | 静态内置      | `src/index.ts`  | neutral 构建、求值通过 | characterPacks, integrations, bots                                              |
| `pet-daily-quests`               | 静态内置      | `src/index.ts`  | neutral 构建、求值通过 | 无                                                                              |
| `pi-latex-workbench`             | 非默认/示例   | `dist/index.js` | neutral 构建、求值通过 | 无                                                                              |
| `playwright-mcp`                 | 静态内置      | `src/index.ts`  | neutral 构建、求值通过 | 无                                                                              |
| `pro-ide-fixture`                | 非默认/示例   | `src/index.ts`  | neutral 构建、求值通过 | 无                                                                              |
| `prompt-templates`               | 静态内置      | `src/index.ts`  | neutral 构建、求值通过 | 无                                                                              |
| `repowiki`                       | 桌面预置      | `—`             | 未测 native runtime    | 未比较                                                                          |
| `ripgrep-tools`                  | 静态内置      | `src/index.ts`  | neutral 构建、求值通过 | 无                                                                              |
| `screenshot`                     | 静态内置      | `src/index.ts`  | neutral 构建、求值通过 | 无                                                                              |
| `skill-recorder`                 | 静态内置      | `src/index.ts`  | neutral 构建、求值通过 | 无                                                                              |
| `sre-agent`                      | 静态内置      | `src/index.ts`  | neutral 构建、求值通过 | 无                                                                              |
| `stagehand-mcp`                  | 静态内置      | `src/index.ts`  | neutral 构建、求值通过 | 无                                                                              |
| `strix-security`                 | 静态内置      | `src/index.ts`  | neutral 构建、求值通过 | 无                                                                              |
| `test-lsp-contribution`          | 非默认/示例   | `src/index.ts`  | neutral 构建、求值通过 | 无                                                                              |
| `ui-surface-reference`           | E2E reference | `src/index.tsx` | neutral 构建、求值通过 | 无                                                                              |
| `wasm-example-formatter`         | 非默认/示例   | `—`             | 未测 native runtime    | 未比较                                                                          |
| `web-clone`                      | 静态内置      | `src/index.ts`  | neutral 构建、求值通过 | 无                                                                              |
| `web-tools`                      | 静态内置      | `src/index.ts`  | neutral 构建、求值通过 | 无                                                                              |
| `workflow-ai`                    | 静态内置      | `src/index.ts`  | neutral 构建、求值通过 | 无                                                                              |
| `workspace-tools`                | 静态内置      | `src/index.ts`  | neutral 构建、求值通过 | 无                                                                              |
| `zhihu-content-pipeline`         | 静态内置      | `src/index.ts`  | neutral 构建、求值通过 | skills, mcpServerPresets, characterPacks, agentTeamTemplates, workflowTemplates |

## 证据文件

- `build-inventory.json`：67 个插件的独立构建清点，保留 neutral 失败原因与 browser 重试结果。
- `runtime-inventory.json`：62 个 frontend 的求值结果与 manifest 差异。
- `browser-build-probe.json`：三个浏览器构建重试结果。
- `lifecycle-probe.json`：同 ID 覆盖、旧 bundled 版本重新 seed 的实测结果。
- `isolated-node-probe.json`：源码覆盖、真实 CLI importer 的 SDK 解析与 CJS 缓存结果。
- `marketplace-probe.json`：registry 安装完成但未注册的边界探针。
- `verification-results.json`、`baseline-results.json`：现有测试计数与失败断言。
- `source-snapshot.json`：报告结束时的关键源码哈希和 Git HEAD。
- 诊断脚本及临时 bundles 留在 `.codex-tmp/plugin-independent-audit-2026-10-05/`，不属于产品源码。
