---
title: 桌面宠物
description: 活在透明浮层窗口里的 Shimeji 式伙伴 —— 五种窗口角色、规避 Windows 黑矩形的双 rAF 揭示协议、需求/照料/经济模拟，以及两套渲染后端（Live2D 与精灵图）。
---

# 桌面宠物

<Status variant="beta">Beta · ADR-0058 · Dexie（无 schema 升版）</Status>

<TLDR>
  宠物不是应用窗口内的一个挂件 —— 它活在自己的透明置顶 Tauri 窗口中，
  由 `PetWindowRole`（`lib/pet/window-role.ts:18`）告诉同一份产物：这次要启动成五种角色中的哪一种。
  Rust 以 `visible(false)` 创建这些窗口，并且**绝不**在创建路径上显示它们：
  在 Windows 上，一个 `transparent(true)` 窗口若在其 WebView 完成首帧提交之前被显示，
  会渲染成一块不透明的黑矩形。渲染端在挂载后调用共享的揭示逻辑（`lib/pet/reveal.ts`），
  等待**两个 rAF** —— 先布局、后提交 —— 确保透明帧已经上屏，窗口才出现。
  底层是一套真正的模拟：需求衰减、照料状态、金币与商店、经验与升级、成就，
  以及带弹道计算的移动状态机。
</TLDR>

<StatGrid>
  <Stat label="源文件" value="195" hint="lib/pet —— 含测试" />
  <Stat label="UI 组件" value="25+" hint="components/pet + console/ settings/ skins/" />
  <Stat label="React hooks" value="20" hint="hooks/pet" />
  <Stat label="窗口角色" value="5" hint="main · overlay · popup · island · web" />
  <Stat label="领域模块" value="12" hint="soul · needs · care · economy · xp · achievements · behavior · live2d · sprite-v2 · bones · runtime · state" />
</StatGrid>

设计动机见 [ADR-0058](../adr/0058-desktop-pet-subsystem)。宠物状态持久化在 Dexie 中，且未引入自己的 schema 升版。

## 五种窗口角色，同一份产物

```ts
type PetWindowRole = "main" | "overlay" | "popup" | "island" | "web"
```

同一份静态导出会启动进每一种角色；`getPetWindowRole()`（`lib/pet/window-role.ts:70`）
从 Tauri webview label 解析出当前角色 —— `PET_WINDOW_LABEL`（`"pet"`）、
`PET_POPUP_WINDOW_LABEL`（`"pet-popup"`）、`ISLAND_WINDOW_LABEL`（`"island"`）。
`isSecondaryOverlayRole()` 与 `isMainAppWindow()` 是守卫：
它们阻止仅限主窗口的工作 —— 启动引导、迁移、单例 —— 在三个浮层窗口里额外再跑三遍。

## 揭示协议源自一个真实 bug

透明浮层窗口是「创建时隐藏、由渲染端揭示」，而不是由 Rust 显示。
在 WebView 完成首帧提交之前显示一个 `transparent(true)` 窗口，
在 Windows 上会得到一块不透明黑矩形，直到某个操作强制重新合成 ——
也就是「不可见 / 点一下才出现」那个 bug。`lib/pet/reveal.ts` 会等待两个动画帧
（先布局，再提交后）才调用 `revealPetWindow()` / `revealIslandWindow()`，
与主窗口的 `WindowShowInitializer` 契约保持一致。

## 可栖附的「表面」仅限 Windows，并且明确声明

宠物可以爬上其他可见顶层窗口的上边缘并沿其行走（Shimeji 风格）。
`src-tauri/src/pet_window/surfaces.rs` 把它拆成三层，使业务逻辑无需真实桌面即可测试：
`PetSurface` / `PetSurfaces` 这组 serde DTO、
对普通 `WindowCandidate` 记录做纯判定的 `filter_and_sort_surfaces`、
以及薄薄一层 `platform::enumerate`（`EnumWindows` 调用）。
在非 Windows 平台上 `enumerate` 返回空列表，浮层退化为常规的地面游走行为 ——
这是**显式声明的休眠**，而不是悄无声息地损坏。

<Callout type="warn">
  `PetSurface` 是**具名结构体，不是元组**。裸元组会序列化成 JSON 数组，
  TypeScript 包装层随后会静默读到 `undefined` —— `pet_window/mod.rs` 里就有一条针对此事的回归备注。
</Callout>

## 模拟层

```
lib/pet/
  needs/decay.ts               # 需求随时间下降
  care/condition.ts            # 由需求推导出的健康状态
  care/evolution-flavor.ts     # 照料历史如何影响进化走向
  care/notify-care.ts  notify-scheduled-due.ts
  economy/coin-table.ts  item-catalog.ts  shop.ts  streak.ts
  xp/award-table.ts  leveling.ts
  achievements/registry.ts  check.ts
  behavior/locomotion-fsm.ts  ballistics.ts  wander-config.ts
  soul/generate-soul.ts        # 生成的性格
  bones/generate.ts  palettes.ts  prng.ts  account-id.ts   # 确定性的程序化外观
  state/reducer.ts             # 状态机
  runtime/pet-controller.ts  pet-view.ts  init-pet.ts  apply-event.ts
  overlay-geometry.ts  popup-geometry.ts  window-role.ts  reveal.ts
```

由 `account-id.ts` 播种的 `bones/prng.ts`，正是同一账号下宠物生成外观保持稳定、
而不会每次启动重掷的原因。

## 两套渲染后端

`live2d/` 是完整的 Cubism 路径 —— 模型发现、manifest 解析、带校验的 zip 导入、
插件注册步骤、参数 / 情绪映射、口型同步，以及模型资源的 URL 解析器。
`sprite-v2/import.ts` 是更轻量的精灵图包路径。
具体启用哪一套，按角色通过 `hooks/pet/use-active-live2d-model.ts`
与 `use-active-sprite-pack.ts` 解析。

## 相关文档

<Cards>
  <Card title="ADR-0058" href="../adr/0058-desktop-pet-subsystem" description="桌面宠物的决策记录" />
  <Card title="角色" href="../chat/characters" description="宠物的角色与皮肤从何而来" />
  <Card title="语音 / TTS" href="./misc-subsystems" description="use-pet-speak 驱动的 TTS 栈" />
  <Card title="调度器" href="./scheduler" description="触发宠物定时提醒的地方" />
</Cards>
