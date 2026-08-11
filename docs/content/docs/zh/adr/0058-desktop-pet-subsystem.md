---
title: "ADR-0058 — 桌面宠物子系统"
description: "将宠物子系统（components/pet/、lib/pet/、hooks/pet/、stores/pet/、types/pet/、src-tauri/src/pet_window/）的架构记录回填其实际当前形状——三窗口角色模型（main/overlay/popup）、Dexie-vs-Zustand状态分割、子系统无关事件总线和三皮肤（SVG/Live2D/sprite-v2）渲染器——这些都未在其他地方记录。还记录了本波的新增内容：浏览器小部件与Tauri叠加层之间的统一drag/throw物理、可选的环境双胞胎感知信号、全局快捷键+持久自定义快捷方式修复、macOS窗口攀爬、托盘快速actions/mood显示，以及兼容精灵宠物的导入Codex。"
---

# ADR-0058 — 桌面宠物子系统

**状态**：已接受（2026-07-01）**作者**：Max Qian + Claude **Supersedes**：`docs/superpowers/specs/2026-06-02-pet-system-design.md`，`docs/superpowers/specs/2026-06-05-pet-llm-deepening-design.md`

## 背景

宠物子系统是仓库中最大的之一（共127+个共址测试文件，涵盖`components/pet/`、`lib/pet/`、`hooks/pet/`、`stores/pet/`、`types/pet/`、`src-tauri/src/pet_window/`），与子系统地图中其他子系统不同，没有任何ADR。它源自两份设计文档——2026-06-02（原始培育循环+SVG-skeleton规范）和2026-06-05（LLM-deepening+绩效审计后续）——这两份文件都明确推迟了工作，但这些工作后来都已发布：

- 2026-06-02规范中的“超出范围”部分推迟了**Tauri透明的始终在顶部桌面宠物窗口“（”无新Tauri窗口/无新Rust“）和**Lottie/Rive/sprite-sheet皮肤**——这两者均已实现（下方`overlay`/`popup`窗口角色和Live2D皮肤）。
- 2026-06-05 规格的目标声明推迟了**Shimeji式的“爬窗”（“行为丰富度......明确超出范围这一波“））——现已实现（实验性，Windows + macOS）。

该ADR记录了架构的实际情况，然后记录了本次流程中添加的交互统一/孪生感知/平台能力工作。

## 建筑

### 窗口角色模型

宠物的Next.js路由树在三个Tauri的网页视图角色中共享，通过窗口标签`lib/pet/window-role.ts:getPetWindowRole()`一次解决：

| 职责 | 窗户标签 | 路线 | 拥有者 |
|------|-------------|-------|------|
| `main` | `"main"` | （应用壳） | 事件总线 + 控制器（XP/needs/progression） + 应用内浮动小部件（`components/pet/pet-widget.tsx`） |
| `overlay` | `"pet"` | `/pet-overlay` | 仅展示——透明、始终在顶部、无框的精灵窗口（`components/pet/pet-overlay-view.tsx`） |
| `popup` | `"pet-popup"` | `/pet-popup` | 仅展示——右键快速菜单+对话Composer，一个专用窗口（不调整叠加层大小以避免出现resize/reposition竞争——详见 `src-tauri/src/pet_window/popup.rs`） |

`components/pet/pet-mount.tsx` 将 controller/event-bus/command-registration 逻辑 **only** 安装在 `main`（以及 web/browser 等效程序）中——`overlay`/`popup`明确 no-op，因此XP不会在窗口间重复授予。跨窗口状态（视觉状态、气泡、一次性游戏、用户交互）通过`BroadcastChannel`桥（`lib/pet/events/cross-window-bridge.ts`）流动。

### 数据流

```
subsystems (chat/agent-team/goal/scheduler/connector/terminal/workflow/twin)
    → lib/pet/events/sources/*.ts (thin adapters, one per subsystem)
    → PetEventBus (lib/pet/events/pet-event-bus.ts — singleton, mirrors lib/connectors/bus.ts)
    → lib/pet/runtime/pet-controller.ts (serialized promise chain)
         ├─ lib/pet/runtime/apply-event.ts → XP/needs/growth (pure)
         ├─ lib/pet/state/reducer.ts → PetVisualState (pure)
         └─ lib/pet/achievements/check.ts
    → Dexie (lib/db/pet.ts) persists the durable PetProfile
    → stores/pet/pet-store.ts (Zustand — ephemeral visualState/oneShotQueue/bubble/minimized/position only)
    → hooks/pet/use-pet.ts (Dexie useLiveQuery + lib/pet/runtime/pet-view.ts's pure view derivation)
    → components/pet/pet-renderer.tsx → skins/{svg-skin.tsx | live2d-skin.tsx | sprite-v2-skin.tsx}
```

**Dexie与Zustand的分离**是有意为之：持久记录（档案、需求、XP/level/stage业绩、绑定）仅存于Dexie中，并被反应式读取;`usePetStore`（Zustand）仅保留帧到帧的短暂状态，通过`partialize`持续存在`{ minimized, position }`到`localStorage`（键`cognia-pet-ui`）。这正是跨窗口同步能够依靠自身交叉表反应Dexie而非定制同步协议的原因。

### 事件总线

`PetEventBus`会把所有子系统都从宠物中解耦——子系统从不导入宠物内部设备，他们通过`lib/pet/events/sources/`的源适配器调用`emitPetEvent(...)`。控制器通过优先级排序的纯简化器（`error > waiting > review > thinking > team-run`，否则需要衍生的静止状态）和一个`PASSIVE_KINDS`集合（`idle`、`inboundMessage`、`scheduledRun`，加上该波的 `twinBusy`/`twinMilestone`）映射事件，其静止状态会延续给持续的`unwell`护理条件，而不是覆盖它。

### 皮肤系统

`components/pet/skins/resolve-effective-skin.ts`选择`svg`（默认、内置向量、`motion/react`变体）、`live2d`（用户导入模型、懒散加载的 pixi.js canvas 主机，初始化门禁严格模式安全）和`sprite-v2`（存储在 Dexie 中的验证兼容 Codex v2 图集）。导入的皮肤在所选资产缺失或无法渲染时会退回到SVG。`PetSkin`接口（`types/pet/skin.ts`）仍然是稳定接缝，因此三种渲染器共享相同的视觉状态机和接口。

## 这一波的决策

### D1 — 统一浏览器小部件与Tauri叠加层之间的交互物理

Tauri叠加层的互动更丰富（通过`lib/pet/behavior/ballistics.ts`+`lib/pet/overlay-geometry.ts`实现释放速度投掷物理，通过`lib/pet/interaction/hit-zones.ts`实现身体区域反应），而应用内的小部件则是纯`framer-motion` `drag`，没有投掷，没有区域反应——这带来了真正的跨接口体验差距。

**决策**：将点击、拖曳和投掷指针状态机提取到一个接口无关的hook（`hooks/pet/use-pet-drag-gesture.ts`），该报告deltas/velocity，并让调用者决定“移动”的含义——是OS窗口位置（覆盖层）还是本地DOM偏移量（widget，通过新建的`hooks/pet/use-pet-widget-throw.ts`将相同的`stepBallistic`物理与控件自身容器边界重用）。小部件的拖拽偏移现在通过`stores/pet/pet-store.ts`已有的`position`字段——在此更改前是死代码（声明、文档，`pet-widget.tsx`从未读取或写入）——而不是添加新的。在小部件上点击身体区域会播放与叠加层相同的局部一次性装饰，但故意**不**赋予XP（XP停留在互动面板的明确“宠物”按钮上），与覆盖层自身区分区域装饰和XP-granting `petted`事件相匹配。

### D2 — 选择加入环境双胞胎意识

宠物之前唯一的双胞胎结合是单向且LLM-side-channel-only：`lib/pet/llm/character-persona.ts`在双胞胎`Character`绑定的对话中阅读预先计算好的、already-PII-redacted `voiceSummary`为宠物增添色彩的*语音文本*——这从未影响mood/animation。

**决策**：一个新的选择加入`PetSettings.twinAwareness`（默认关闭，镜像`proactive`/`llmSpeak`的选择加入形状）允许宠物的情绪通过一个新的`lib/pet/events/sources/twin-activity-source.ts`响应**单用户选择的双胞胎***背景工作活动，而该通过*`PetEventBus`所有其他来源*相同的*线路连接。信号仅基于`TwinJob`元数据（`status`/`kind`/`queuedAt`/`completedAt`——numeric/enum字段，没有自由文本路径），从不依赖Twin内容（源、区块、精简配置文件），因此信号本身无需PII 门禁——这是结构上的PII-avoidance，比事后涂黑文本更强且更便宜。两个衍生事件：`twinBusy`（任何活动作业;重用`thinking`视觉状态）和`twinMilestone`（刚完成的`distill`/`re-distill`作业;重用`happy`）——两者都是`PASSIVE_KINDS`成员，因此永远不会覆盖持续的 `unwell` 条件，并且都携带 `0` XP（纯环境）。气泡复制是特有的（“安静地翻阅你的笔记......”），因此这两种环境状态与普通背景工作有明显区别，尽管它们在这一波的视觉状态上共享。

**已拒绝**：实时LLM-summarized工作负载评论（重新引入每tick LLM“绝不触碰模型流水线/极小令牌预算”规则以防止）;默认在所有双子之间聚合（双胞胎注册表是明确的多实例，没有“主”指针——显式单一选择更易辨认）;将作业失败映射到`error`可视化状态（如果将背景双流水线的故障误认为“你现在正在做的某件事失败了”，即减速器中最高优先级信号）。

### D3 — 通过现有统一捷径注册表实现全局快捷键，加上它暴露的真实持久性漏洞

`pet.toggle-window` 命令（`lib/pet/commands.ts`，通过`lib/plugin/commands/registry.ts`注册，与`pet.feed`/`pet.play`/`pet.pet`并存）可绑定于**现有**的 `ShortcutRegistry`（`src-tauri/src/shortcuts/`）——没有新Rust 命令，因为任何注册的命令 ID已经通过`shortcut://triggered` → `lib/tray/dispatcher.ts`调度。`pet-widget.tsx`自己的切换菜单项现在调用命令包裹时的`toggleDesktopPetWindow()`，所以只有一个地方拥有open/close + 持久化逻辑，并且它总是重新查询活OS窗口状态，而不是信任缓存的组件状态。

布线后发现了一个预先存在的空白：自定义（非内置）快捷键绑定只存在于Rust的进程注册表中，而注册表只在启动时重新播种三个硬编码内置的和弦——任何用户自定义和弦在每次重启时都会悄无声息地消失。`lib/shortcuts/registry.ts` 中通过保持自定义绑定（通过`lib/tauri/store.ts`，layout/autostart已经用同一个文件托盘）在`hydrate()` `cognia.store.json`中重新应用自定义绑定来解决了（不只针对宠物快捷键）。

### D4 — macOS窗攀爬（Shimeji风格的停泊）

`src-tauri/src/pet_window/surfaces.rs`的可停留接口枚举仅限Windows（`EnumWindows`）;纯filter/sort层（`filter_and_sort_surfaces`）已经实现了平台独立。通过`CGWindowListCopyWindowInfo`添加macOS `platform::enumerate()`（`core-graphics`/`core-foundation`本身已是自动化后端的macOS-target依赖——无需新crate），并由`kCGWindowOwnerPID`对`std::process::id()`进行自我排除（同时捕获该过程的每个窗口——main/overlay/popup——比Windows的标签HWND列表更简单，且无需AppKit/`NSWindow`互操作性）。Linux 仍保留在现有的空存根上：Wayland 没有稳定的跨应用窗口几何结构API（这是合成器的安全边界），仅支持 X11 被认为不值得为日益减少的 Linux 会话付出维护接口。`PetWanderSettings.climbWindows`和设置现在UI显示“仅限Windows和macOS”;在Linux（`lib/tauri/os.ts:isLinuxPlatform`）中，该开关带有解释提示时被禁用。

### D5 — 托盘情绪显示 + 快速操作

`TrayStateSnapshot`获得了一个可选的`pet`字段（可选，非必需，因此现有的合成测试快照无需更新），由与该控件本身相同的`computePetView`懒衰减路径的`lib/tray/state-snapshot.ts`填充。`lib/tray/status-section.ts`显示一个粗略的三段表情表情情绪行（不是精确百分比——托盘是可截图的OS 接口），以及一个最低优先级的`petNeedsAttention` tooltip/status状态（落后于automation/goal/streaming）。一个新的`tray.pet`子菜单（由Feed/Play/Pet+设置链接）由`when: "pet.enabled"`限制，调度通过D3引入的相同`pet.feed`/`pet.play`/`pet.pet` 命令——没有新的Rust端调度逻辑，因为`{kind: "command", commandId}`托盘载荷已经通过`executeCommand`路由。

### D6 — 通过现有皮肤缝隙实现Codex兼容v2精灵宠物

外部`$hatch-pet`工作流程会产生一个固定的 v2 合同（`pet.json` 加上一个 PNG/WebP `1536×2288` 图集）。Cognia 不会在浏览器内执行这种面向文件系统的技能。在Tauri中，外观设置会Codex主聊天中提供任务草稿，包含用户的概念和`$hatch-pet`指令;用户审核并发送文件，然后通过同一个设置面板导入已完成的文件。网页和移动端可以导入和渲染已生成的包，但不会显示代理任务启动器。

导入边界将生成文件视为不可信：它要求合同版本2、文件系统安全的稳定ID、匹配的path/MIME地图集尺寸、唯一ID、有界元数据，以及25 MiB图像上限才能解码。验证过的blobs和manifest元数据存储在加法表中Dexie v119 `petSpritePacks`表中;`PetSettings.activeSpritePackId`只存储选定的ID。反应式查找包含在 `sprite-v2-skin.tsx` 中，因此每个现有渲染器接口都能获得皮肤而不复制持久化逻辑。Cognia将其更丰富的州级词汇映射到合同的idle/run/wave/jump/failed/waiting/running/review行，并尊重pause/reduced-motion偏好。丢失或删除的包会退化到内置的SVG皮肤。

### D7 — 每个 WebView 只有一个受治理渲染边界

设置预览、控制台头像、小部件和浮层过去可以各自初始化 timer、object URL 或 WebGL context。
同时，皮肤选择是自由字符串，可选 Live2D 资源会被静默丢弃，Sprite v2 的两行视线图元也未使用。
这些看似不同的症状其实来自同一个所有权问题：没有模块跨 surface 治理渲染器能力、兼容性和资源生命周期。

**决策**：`types/pet/skin.ts` 现在承载类型化选择、能力、渲染模式、视线目标和诊断契约。
`lib/pet/skin-runtime.ts` 是每个 JavaScript realm 的单例（因此每个 WebView 一个），按
`configuration > interactive > console > thumbnail` 授予唯一 live lease，为其他预览提供快照或
占位，缓存并撤销 object URL，并向开发/测试暴露资源计数器。Live2D context loss 自动恢复一次；
第二次则进入显式、可由用户恢复的 degraded 状态。

三套皮肤统一遵循 `suspended/reduced > held > one-shot > locomotion > semantic state > idle/gaze`。
Sprite v2 将第 9–10 行映射到顺时针 16 个视线桶；SVG 复用既有面部图元；Live2D 在参数存在时
使用标准 head/eye/body/mouth 参数。Web 仅使用页内视线。Tauri 新增最小权限、本地 cursor-position
command，采样不超过 10 Hz，并在视线、可见性或挂起门禁关闭时立即停止。视线样本不会持久化、
发送给 LLM 或传输到网络。

Live2D 导入现在校验完整引用图，并在非索引模型元数据中持久化带版本的 `ready`/`degraded`/
`invalid` 兼容摘要。settings、moc 和必要纹理缺失时阻止激活；缺失可选 motion、expression、sound、
physics 和 pose 时，清理对应引用并报告。路径穿越、归一化重复、大小写歧义、损坏图片、Cubism 2
和大小上限都会在持久化前失败。官方 Hiyori/Haru 测试数据固定 revision 与 SHA-256，下载到测试缓存，
而不提交模型二进制。

### D8 — 一个主从控制台与一个自定义配置所有者

**决策**：`/pet` 采用响应式主从工作区。桌面端使用分组导航轨道与独立滚动的详情面板，窄容器把
相同分组放入 shadcn Sheet；`PetConsoleTab`、`?tab=` 深链、插件 slot context 与跨窗口消息形状均
保持不变。详情区域以平铺 section 和分隔线表达层级，紧凑 widget、popup、overlay 继续保留必要外框。

`components/pet/settings/pet-customization-workspace.tsx` 是 Customize 与 Settings 共同直接渲染的唯一
配置所有者。它统一暴露 SVG、Live2D、Sprite v2、互动、声音、照料、Twin 与受能力门禁约束的桌宠
窗口控制，并拥有响应式受治理预览、fallback 诊断与重试。宠物档案重置使用破坏性确认，并与 Settings
Shell 的配置重置明确区分。本决策只改变 UI 组合与配置所有权，不改变任何持久化结构、成长规则或
Tauri 窗口协议，因此不需要 schema migration。

## 后果

- 宠物子系统的真实架构现在无需穿越两个陈旧的规格和源树就能发现。
- D1–D5 各自可逆（设置标志、hook交换、加法Rust模块、加法DTO字段）——都不需要Dexie迁移。D6 被第三个皮肤注册和一个新增 Dexie table/version 隔离。D7 只增加非索引模型元数据和一个渲染所有者，D8 只改变 UI 组合与配置所有权，因此两者都不需要 Dexie schema 升版。
- 文档债务故意未完全关闭：`docs/superpowers/specs/2026-06-0{2,5}-*.md`被标记为原地被取代（非删除——根据项目的“标记，不删除”的惯例保留历史价值），而非重写，因此它们捕获的*决策历史*（为什么是SVG-over-sprite-sheet，为什么是侧信道LLM，是前技术研究）得以保持完整。
