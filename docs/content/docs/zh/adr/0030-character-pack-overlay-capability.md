---
title: ADR-0030 — 角色包 Overlay Capability
description: 插件贡献的角色捆绑（`character-pack`）作为 `OVERLAY_REGISTRY_CAPABILITIES` 的第 5 条 capability — 仅 overlay 注册、命名空间化运行时 id、Dexie 优先 union、用户克隆归因、以及通过本地包存储绕过 marketplace 安装管线导入独立 `.cognia-pack.json`。
---

# ADR-0030 — 角色包 Overlay Capability

**状态**：Proposed (2026-05-22)
**作者**：Max Qian + Claude Opus 4.7
**影响范围**：`lib/plugin/registries/`、`lib/db/characters.ts`、`lib/claude/build-options.ts`、`components/settings/characters-section.tsx`、`components/chat/character-picker.tsx`、`components/chat/chat-view.tsx`、`components/mobile/discover/character-card.tsx`、`lib/plugin/character-pack/`（新增）

## 背景

cognia-next 已经具备成熟的 `Character` 子系统（`lib/claude/types.ts:Character`、Dexie `characters` 表、CRUD + Settings UI + Mobile Discover + Twin 软绑 + `build-options.ts:resolveSendOptions` 发送时合并），但缺少便携「角色包」的概念，也没有插件贡献角色的 capability。

审计确认的缺口：

- `PLUGIN_CAPABILITY_CONTRACTS` (`lib/plugin/contracts/plugin-capabilities.ts:61`) 没有 `character` / `persona` / `character-pack` 条目。
- `OVERLAY_REGISTRY_CAPABILITIES` (`lib/plugin/contracts/capability-bridge-map.ts:85`) 只覆盖 4 条 capability：`skills`、`mcp-server-preset`、`native-anthropic-tool`、`external-agent-preset`。
- `PluginManifest` 没有 `characterPacks` 字段。
- 插件无法贡献角色；用户无法导入便携包文件；内置 seed 与插件贡献之间没有合并 / 优先级语义。

用户要求角色包：

1. 沿用现有 overlay-registry 模式（不在 `PluginManager` 加新的派发机制）。
2. 插件禁用后用户的编辑成果不被破坏。
3. 自带捆绑依赖（skills / mcp-presets / native-tools / a2ui catalog）。
4. 可作为独立 JSON 文件导入 / 导出。
5. 与 Settings、移动端、聊天选择器 UI 无缝集成，且不引入新的视觉原语。

首版草案忽略了若干既有模式（i18n 的 `{ns,key}` 在任何 manifest 都未使用；marketplace 安装拒绝合成 manifest；许多"新组件"可以复用 `<Badge>` / `<Accordion>` / `<Alert>` / `usePluginStore`）。本 ADR 记录的是修正后的设计。

## 决策

把 `character-pack` 作为 `OVERLAY_REGISTRY_CAPABILITIES` 的第 5 条 capability 引入。插件 manifest 声明 `characterPacks: PluginCharacterPackDef[]`；插件管理器现有的 `for (const cap of OVERLAY_REGISTRY_CAPABILITY_KEYS) descriptor.registerEntry(...)` 循环会自动接入，零侵入。独立 `.cognia-pack.json` 走单独的 `local-pack-store`，以 `pluginId = "local:imported"` 注册进同一 overlay。

### 8 个关键决策

**(D1) 仅 overlay 注册。** 插件贡献的角色只存在于内存 `character-pack-registry`（`createOverlayRegistry<PluginCharacterPackDef>()` 闭包），永不持久化到 Dexie。禁用 / 卸载是原子的：一次 `unregisterByPlugin(pluginId)` 的 Map 扫描就清空该插件贡献的全部包。

**(D2) 命名空间化的运行时 id。** Host 在投射时拼出合成的 Character id：`cognia-pack:<pluginId>:<packId>:<localId>`。该命名空间与 Dexie 的 `char_builtin_*` / `char_<ts>_<rand>` 物理隔离，碰撞不可能 — union 路径里保留的 byId Map 是防御性兜底，实际不会触发。

**(D3) Union 中 Dexie 优先。** `listCharacters()` 把 Dexie 行与 `listAllPackCharacters()` 合并，id 碰撞时 Dexie 总是胜出。`resolveCharacterById(id)` 是 `build-options.ts:resolveSendOptions` 的查询函数：先查 Dexie，未命中再查 `getPackCharacterByRuntimeId(id)`，否则 undefined。

**(D4) 用户克隆在禁用后存活。** 复制 overlay 角色会写入一条新的 Dexie 行，携带 `sourcePluginId` / `sourcePackId` / `clonedFromPackCharacterId` / `packVersionAtClone`。禁用贡献插件会移除 overlay，但克隆仍可编辑。插件重启后若 `pack.version` 改变，克隆行挂"Update available"徽章 — 永不自动覆盖。

**(D5) 不迁移内置 seed。** `seedBuiltInCharacters()` (`lib/db/characters.ts:113`) 完全保留 — 首次启动时 seed 的 6 条 Dexie 行。插件包在其上叠加。曾考虑把 seed 迁到首方插件 (`plugins/cognia-character-seeds/`)，因引入聊天启动的加载顺序依赖（插件必须先注册才能解析任何内置 id）且无任何用户可见收益而否决。

**(D6) `requires` 是 warn-not-block。** 包级 `requires: { skills, pluginSkillIds, mcpServerPresets, nativeAnthropicTools, a2uiCatalogId }` 在注册时校验，缺失任一引用 id 时发出 `PluginCapabilityDiagnostic { code: "plugin.capability.partial" }`。包仍然完成注册 — 引用缺失依赖的角色会通过现有 `resolveSendOptions` 路径优雅降级（未知 skill id 今天就会被静默丢弃）。硬 `blocked` 保留给 capability 契约级别的决策。

**(D7) i18n 走插件 bundle，不走 manifest shape。** `PluginCharacterPackDef.name` 与 `PluginCharacterDef.name` 是普通 `string`（与所有其他 capability 的 manifest 字段一致）。插件需要本地化标签时通过既有的 `lib/i18n/plugin-i18n-registry.ts:registerPluginI18n` 注册自己的翻译 bundle，host 渲染 `plugin.<pluginId>.<key>`。早期草案曾提出 `name: string | { ns, key }`，因没有其他 manifest 字段采用此 shape，且插件 i18n bundle 通道已存在而否决。

**(D8) 独立 `.cognia-pack.json` 绕过 marketplace 安装。** Marketplace 安装管线期望 Tauri 解压的 tarball — 不接受合成 manifest。所以独立包使用单独的 `lib/plugin/character-pack/local-pack-store.ts` 读写 `<appDataDir()>/cognia/local-character-packs/<id>.cognia-pack.json` 并以 `pluginId = "local:imported"` 注册进 overlay。App 启动时通过新建的 `LocalCharacterPackInitializer` 运行 `scanAndRegisterLocalPacks()`。Web 模式是优雅 no-op。

## Schema

### `Character` 扩展 (`lib/claude/types.ts:1479`)

```ts
sourcePluginId?: string           // 仅 user-cloned 行携带
sourcePackId?: string
clonedFromPackCharacterId?: string
packVersionAtClone?: string
```

四个字段全部可选、非索引、旧行全部 undefined → 被徽章逻辑视为「user-created」。

### Dexie 迁移

**v47 → v48**。纯 shape 加法 (`this.version(48).stores({})`)，无索引变更，无升级钩子。这四个新字段为 JSON 列，只在 `duplicateCharacter()` 源是 overlay 合成 id 时填充。

### `PluginCharacterPackDef`

见 `types/plugin/plugin-character-pack.ts`。包身份是 `{ id, version }`；角色用包内 `localId` 标识。每个包软上限 50 个角色（由 `defineCharacterPack()` 强制）。

### 文件格式 (`lib/plugin/character-pack/schema.ts`)

```ts
{ schemaVersion: 1, pack: PluginCharacterPackDef, signature?: { algo, pubKey, sig } }
```

未来格式版本递增 `schemaVersion`；今天的读取器拒绝未来版本并附带可操作错误信息（"Upgrade Cognia"）。signature 字段为既有 Ed25519 验证器 (`lib/plugin/wasm/signature-verifier.ts`) 的前向兼容预留；V1 接受未签名文件。

## 生命周期表

| 事件                             | 行为                                                                                                                                                                                   |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 插件 enable                      | `PluginManager` 遍历 `OVERLAY_REGISTRY_CAPABILITY_KEYS` → `descriptor.registerEntry(pack, { pluginId })` → `registerCharacterPack`。Settings + picker UI 通过 Zustand 订阅重渲。       |
| 插件 disable                     | `unregisterCharacterPacksByPlugin(pluginId)` — 单次 Map 扫描。Dexie 克隆不动。在飞 session 的 overlay `characterId` 触发 destructive `<CharacterMissingBanner>` 并回退到应用默认配置。 |
| 插件重启 + 新版本 `pack.version` | 同 `sourcePluginId+sourcePackId` 的 Settings 行挂 "Update available" 徽章。用户选 Re-clone（新行）或 Dismiss。                                                                         |
| 用户克隆 overlay                 | `duplicateCharacter(syntheticId)` 解析 overlay 后写入一条 Dexie 行，四个 `source*` 字段填好。                                                                                          |
| 本地包导入                       | `importLocalPack()` 校验 schema → 写文件 → `registerCharacterPack(..., { pluginId: "local:imported" })`。同 id 重导会覆盖。与真插件包 id 冲突时拒绝并返回可操作错误。                  |
| 本地包删除                       | `deleteLocalPack(id)` 取消注册 + 删文件。Dexie 克隆存活。                                                                                                                              |

## 备选方案

- **插件角色落 Dexie，禁用时清理** — 否决。在飞 session 上有竞态（行在流中途消失）；克隆语义更难推理；overlay 模型才是其他每个 capability 的做法。
- **把内置 seed 合并到首方插件** — 否决。给聊天启动加载顺序依赖，没有任何用户可见收益。Seed 足够稳定，可以留在 `lib/db/characters.ts`。
- **manifest 内的 `name: string | { ns, key }`** — 否决。没有其他 manifest 字段使用此 shape；插件 i18n bundle 通道已经存在并且是本地化插件提供字符串的规范方式。
- **为 `.cognia-pack.json` 合成 tarball 走 marketplace 安装** — 否决。过重；local-pack store 完成全部工作流大约 120 行 vs 假装是插件大约 500 行。本地包的生命周期也不同（不参与 enable/disable，无插件权限）— 把它们建模成插件会模糊这一区别。
- **新建 `<PluginSourceBadge>` 组件** — 否决。既有 `<Badge variant="outline">` 已经覆盖视觉；`characters-section.tsx` 和 `character-card.tsx` 各一行三元判断比新建一个组件文件更清晰。

## 验证

- `pnpm test -- lib/plugin/registries/character-pack-registry.test.ts lib/db/characters.test.ts lib/plugin/character-pack lib/claude/build-options.test.ts lib/plugin/contracts components/chat/character-picker.test.tsx components/chat/character-missing-banner.test.tsx hooks/plugins/use-plugin-metadata.test.ts` — 214 tests green。
- `pnpm lint:i18n` — key 平价 OK，baseline 重写为 528 处。
- `pnpm audit:slots` — 不受影响（未引入新 UI slot）。
- 手动 Tauri 验证场景见 `~/.claude/plans/serene-launching-scroll.md`。

## 风险

1. **跨插件 skill 引用**。包角色引用 `skillIds: ["foo"]` 但 `foo` 由另一个未装插件提供。`resolveSendOptions` 今天就会静默丢弃未知 skill id；register-time 校验器 (`PluginCapabilityDiagnostic`) 在 Settings 行上挂黄色 chip 提示。
2. **包改名后 clone 失效**。如果维护者在版本间改了 `localId`，`clonedFromPackCharacterId` 不再解析。文档化为包作者守则：发布后不要改 `localId`。
3. **session.characterId 悬挂**。由 `<CharacterMissingBanner>` 覆盖。重新启用后 banner 自动消失。
4. **manifest 体积**。50 角色 × 10 KB systemPrompt = 500 KB / 插件；`createOverlayRegistry` 按引用存储，内存代价可控。SDK helper 强制软上限。
5. **插件卸载时插件自有 Dexie 表未自动清理**（既有 gap，非本次引入）。`sourcePluginId` 指向已删插件的克隆变成 Dexie 孤儿 — 仍可用，只是没有 overlay 父级。

## 修订 — 2026-05-23（v50）

### 反转：D5 — 内建角色也走 overlay

原 ADR（§D5、§备选方案）选择把 6 个内建角色排除在 overlay-registry 之外：它们留在 `seedBuiltInCharacters()` 里作为普通 Dexie 行。两点原因让这个选择不再最优：

1. 新的 **Apply Update**（选择性覆盖 pack-managed 字段、保留用户改动）流程构建在 overlay + snapshot 模型之上。把内建排除在外意味着 Cognia 持续优化自家 persona prompt 时无法就地推送给用户。
2. 概念一致性：其他所有角色来源 —— 第三方插件、本地 `.cognia-pack.json` —— 都走 overlay registry。把内建作为特例会在 `listCharacters` / `duplicateCharacter` / 设置 UI 里产生两条并行代码路径。

**新布局：**

- 6 个 persona 搬到 `plugins/cognia-builtin-characters/src/index.ts`，是一个真正的 first-party 插件。`BUILTIN_PACK.id = "builtin"`，pluginId `cognia-builtin-characters`，版本 `1.0.0`。每次启动通过标准插件管理器激活路径重新注册。
- Dexie schema **v50** 增加一个 upgrade hook，给老的 `char_builtin_*` 行打上新的 `sourcePluginId` / `sourcePackId` / `clonedFromPackCharacterId` / `packVersionAtClone` 归属字段。用户自定义原样保留 —— 只追加归属字段。
- `listCharacters` 新增 **clone-hides-overlay** 去重规则：当 Dexie 行的 `clonedFromPackCharacterId` 匹配某个 overlay 合成 id 时，picker 隐藏 overlay 那份。内建角色因此在 UI 中只出现一次（Dexie 行），并且归属徽章 + Apply Update 流程都和第三方包克隆一样工作。

### 新增：v2 manifest 字段 + Apply Update 流程

三个可选字段加到 `PluginCharacterDef`，由 `CHARACTER_PACK_FILE_SCHEMA_VERSION = 2` 控制：

- `avatarImage?: { tauriPath?, webDataUrl? }` — 作者按 shell 自选；UI 找不到时回退到 `avatarEmoji + avatarColor`。
- `persona?: { tone, personality, openingMessage, exemplarPrompts }` — 本轮仅供展示（build-options 流水线暂不消费）。
- `voiceProfile?: { provider, voiceId, rate?, pitch?, volume? }` — 通过新的 `lib/plugin/character-pack/character-voice.ts:resolveCharacterVoice` 投射为 `Partial<SpeechSettings>` 叠加层送给 `TTSOrchestrator.speak()`。不修改 `AppSettings`。

`SUPPORTED_SCHEMA_VERSIONS = {1, 2}` —— v1 包继续可读；新导出统一写 v2。

**Apply Update**（选择性覆盖）：

- `Character.pristineSnapshot?: PackPristineSnapshot` 记录克隆 / 上一次 apply 时 pack-managed 字段的值。
- `lib/plugin/character-pack/diff-pack-update.ts` 是一个纯 diff：逐字段，若 `row[f]` 仍等于 `snapshot[f]`，则用户没动过 → 可以从最新 overlay 覆盖；否则保留。
- 设置 UI 新增 **应用更新** 按钮（单行）和 **全部应用 (N)**（当同 pack 至少 2 个克隆有待更新时）。对话框先展示双列 diff，用户确认后才落库。
- 没有 snapshot 的旧 v48 克隆走 confirm-before-overwrite-all 兜底 —— 对话框上挂出警告，提醒用户先复制一份做备份。

### 不在本轮（后续工作）

- 把 `resolveCharacterVoice` 实际接到 TTS dispatch 调用点。
- `useTauriAssetUrl` hook，用于渲染 `avatarImage.tauriPath`。
- ~~`.cognia-pack.json` 文件的 Ed25519 签名校验。~~
  已于 2026-08-03 交付 —— 见下方修订。
- ~~新的 `requires` 维度类型（theme-pack / connector / provider）。~~
  已于 2026-08-03 交付 —— 见下方修订。

---

## 修订 — 2026-08-03（信任链 + 三个新 `requires` 维度）

交付上面"不在本轮"的最后两条。

### 新增：角色包信任模型只有两个状态

```ts
type CharacterPackTrust =
  | { state: "verified"; algo; publicKey; fingerprint; shortFingerprint; signature }
  | { state: "unsigned" }
```

刻意**没有 `"invalid"` 状态**。签名验证不通过的已签名包会在扫描 / 导入
边界被拒绝，根本进不了 registry，因此这个类型无法表达一个谎言。UI 侧也就
没有 `invalid` 分支要渲染 —— registry 里不存在这样的包。

`resolvePackTrust` 失败即关闭：`reason: "host-unavailable"` 同样是
`ok: false`。既然签名存在却无法校验，我们就没有资格假设它没问题。

### 裁定：签名字节不含 `schemaVersion`

签名覆盖的是**仅 `pack` 对象**的 RFC 8785 规范化 JSON。`schemaVersion`
与 `signature` 属于文件外层包装，在规范化之前被剥离。

正因如此 `CHARACTER_PACK_FILE_SCHEMA_VERSION` 可以停在 `2` 且无需 Dexie
迁移：导入一个已签名的 v1 文件并按 v2 重写，签名依然有效。如果签的是外层
包装，那么每一次 schema 升版都会让世上所有已签名的包失效。

### 裁定：插件贡献的包完全不显示信任徽章

它们的真实性已经由插件安装回执（`PluginVerificationReceipt`）锚定。在旁边
渲染"未签名"等于声称存在一个并不存在的缺口 —— 那是主动误导，而不只是噪音。
只有来源不定的本地 `.cognia-pack.json` 文件才展示未签名状态。

### 裁定：信任存在旁路 map，而不是 registry 的 `meta` 袋

把 overlay registry 的 `meta` 袋加宽是最直观的存法，也是一个信任伪造漏洞：
`registerCharacterPack` 由 `@cognia/plugin-sdk` 再导出，任何插件都能写
`meta.trust = "verified"` 给自己发一枚徽章。信任只由 SDK 不再导出的、
宿主专用的 `registerCharacterPackWithTrust` 写入。SDK 可见的
`registerCharacterPack` 现在是一层包装，强制写入 `{ state: "unsigned" }`，
因此插件用同一个 pack id 覆盖注册也无法继承此前的已验证徽章。

### 新增：三个 `requires` 维度，仅告警

`themePacks`（规范化的 `"<pluginId>.<packId>"` 键）、`connectors`（平台
kind）、`providers`（规范 provider id）。`missing-theme-pack` /
`missing-connector` / `missing-provider` 三个 code 加入联合类型。按 §B.6，
它们全部只是告警 —— 包照常注册、照常出现在 picker 中、其角色照常可解析。

连接器可用性由 `CONNECTOR_METADATA.filter(m => m.status !== "planned")`
计算，**而非**原始的 `ALL_PLATFORM_KINDS` 联合：`email` / `kook` / `line` /
`mattermost` 在联合里，但 `buildAdapterFromRow` 中并没有对应分支，把它们当作
可用会吞掉一个真实的缺失依赖。

`refreshAllPackWarnings()` 是推模型，所以每个新来源都要自己推一次失效。
主题包从专门的 `warning-refresh-wiring.ts` 推送，由本地包初始化器安装 ——
**不是**从 `theme-pack-registry.ts` 内部推，那会让 `lib/theme` 反向依赖
`lib/plugin`。

顺带修掉两个既有缺陷：已声明的 `missing-a2ui-catalog` code 在函数体里没有
任何分支能发出它；以及角色级 `providerId` 从未被检查。后者可能会让此前
"干净"的包亮起告警。

### 修复：`exportPack` 静默丢弃签名

它调用 `serializeLocalPackFile(pack)` 时漏了第二个参数，导致无论导入的是
什么，导出的包一律变成未签名。现在导出已验证的包会逐字回写原始签名块，
导出的文件仍然可验证。

### 新增：`cognia pack sign` / `cognia pack verify`

只有校验而没有产生签名的手段，等于一个死功能，因此 CLI 一并交付签名器。
签名**内嵌**写入文件自身的 `signature` 对象，而不是分离的 `.sig` ——
一个包就是一个自包含文件，可以直接邮件发送或提交，不会出现配套文件走丢。

`pack sign` 在写盘前先自验。宿主校验的是 JavaScript 产出的字节，而 CLI 用
手工移植的 RFC 8785 实现产出它们；没有这一步自检，格式化 bug 在创作时是
静默的，最终以"用户机器上随机验签失败"的形式暴露。

`pack verify` 在宿主的两个结论之外报告三种：`verified`、`unsigned`
（退出 0 —— 这是受支持且会被标注的状态，CI 可用 `--require-signature`
把它变成错误）、`invalid`（永远非零）。

### 记录：两侧规范化器确实分叉过，是共享 fixture 抓到的

两侧由同一份黄金向量文件驱动：
`lib/plugin/character-pack/__fixtures__/jcs-vectors.json`，Jest 侧 `import`，
Rust 侧 `include_str!`。第一次运行就失败了。

TypeScript 侧先对 key 排序，然后经由一个中间对象交给 `JSON.stringify`。
这会静默地把排序撤销：JS 对象自身的属性顺序会把类整数 key 按**数值**升序
提到最前，与插入顺序无关，于是 `{"1","10","2"}` 又变回 `1, 2, 10`。
RFC 8785 §3.2.3 要的是 UTF-16 码元序 —— `"1" < "10" < "2"`。Rust 的
`BTreeMap` 没有这条规则，两侧正是这样分叉的。

序列化器现在直接拼输出字符串，只把**叶子**交给 `JSON.stringify`，从而在
保留符合 ES 规范的数字格式化与字符串转义的同时，自己掌控 key 顺序。仓库中
签入了一个由真实 `cognia pack sign` 二进制签名的包，Jest 用 Node 自带的
Ed25519 校验它，因此测试证明的是真实产物上的互通，而不只是某人碰巧想到
要写下来的那些向量。
