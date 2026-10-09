---
title: "0219 — 在已配对的手机上远程照看宠物"
description: "修订 ADR-0058 D9。宠物运行时（控制器、悬浮窗、托盘、智能体工具）仍只在桌面壳中运行，但 /pet 控制台可以在与桌面主机配对、且主机声明了 pet.remote-care 的手机或浏览器上操作。手机通过伴侣同步读取五张宠物表的投影只读镜像，并经桌面写入桥发送九个 pet_* 命令，因此每个操作仍由桌面上唯一的控制器执行，XP 只发放一次。外观定制、绑定编辑、重置、桌面窗口和皮肤修复仍只在桌面可用，并明确标注。"
---

# ADR 0219 — 在已配对的手机上远程照看宠物

**状态：** 已接受
**日期：** 2026-10-09
**修订：** [ADR-0058](./0058-desktop-pet-subsystem)（D9：“端到端仅限桌面壳”现在只约束宠物运行时，不再约束控制台）
**相关：** [ADR-0027](./0027-mobile-offline-and-discovery)（伴侣同步）、[ADR-0021](./0021-webrtc-datachannel-wan-transport)（配对传输）

## 背景

ADR-0058 D9 规定宠物端到端只在桌面壳中运行。在网页和 Capacitor 上 `PetMount` 不会初始化，`/pet`
只显示一个“此处不可用”的空状态，唯一的出口是返回聊天。对运行时而言这是对的：控制器是 XP、需求、
冷却和成就的唯一写入者，另一台设备上的第二个控制器会让所有奖励发放两次。

但对控制台而言这是错的。控制台承载着宠物的全部记录，用户离开电脑时即使手机已经与这台桌面配对，
也无法查看或照看宠物。宠物表不在伴侣同步中，也没有任何伴侣命令能触达宠物，手机既没有可读的数据，
也没有可发的指令。

## 决策

### 1. 运行时留在桌面，控制台不必

控制器、悬浮窗与弹窗、托盘、智能体工具和插件宠物 API 继续遵循 D9
（`lib/runtime/surface-contract.ts` 中的 `petRuntimeRequiresDesktopShell`）。`/pet` 表面改为由操作绑定：
`{ operation: "pet_get", standalone: "explain", companion: "remote", offline: "cached-read" }`。
未配对的手机或浏览器会得到契约给出的 `/pair` 补救入口（`petConsoleRequiresPairedHost`），不再是死路。

### 2. 只有一个控制器：操作发往桌面

控制台只解析一次模式：桌面主窗口为 `local`；与声明了 `pet.remote-care` 的主机配对的伴侣端为
`remote`；其他情况给出说明。所有控制台操作都经过同一个提供者（`usePetConsoleActions`），本地与远程实现
返回相同的结果类型，因此两种模式下各个标签页完全一致，远程模式下绝不会调用 `emitPetEvent` 或任何
Dexie 写入函数。

远程操作是新 `pet` 资源上的九个命令（`protocol/companion-*.json`），由 `desktop_writes_bridge` 转发到桌面
WebView 中的 `lib/pet/remote/host-dispatch.ts`：

| 命令 | 作用 |
|---|---|
| `pet_get` | 快照：可用性、不含个人信息的 `projectPetSummary` 投影、冷却、展示信息（请求的皮肤、是否在桌面、是否启用聊天） |
| `pet_act` | 一次照料动作（`fed`…`talked`），可附带消耗道具；主机会在消耗前先检查冷却 |
| `pet_item_purchase`、`pet_item_apply` | 商店购买（新动词 `purchase`）与装饰 |
| `pet_rename` | 改名，与控制器串行执行 |
| `pet_soul_generate` | 通过单飞的 `hatchPetOnce` 孵化；超过 25 秒返回 `pending` |
| `pet_chat_send`、`pet_chat_list`、`pet_chat_clear` | 在主机上与宠物对话，使用主机的设置、PII 闸门与限流 |

这些命令直接调用，绝不进入移动端持久出站队列：几分钟后重放的照料动作会撞上冷却或重复发奖。重试时每个
意图携带同一个幂等键，主机按调用设备保留十分钟。无头大脑没有控制器，回复 `headless-host`；控制器尚未订阅
的桌面回复 `host-starting`；只有 Tauri 桌面会声明 `pet.remote-care`。

`pet_chat_send` 与 `pet_soul_generate` 会消耗主机的模型额度，但它们与 `message_send` 同类
（`client.write`、低风险、无需审批、不受远程控制闸门约束），而不是与 `goal_subgoals_generate` 同类。
已配对的手机是用户自己的设备，操作的是用户自己的宠物；每一轮都受主机的 PII 闸门与宠物发言限流约束，
孵化对每只宠物只发生一次。

### 3. 投影后的只读镜像

伴侣同步新增 `petProfile`、`petAchievements`、`petInventory`、`petCharacterBindings` 和 `petActivityLog`。
档案在主机端投影：账号指纹（原始的服务商账号 ID）被替换为哨兵值，派生出的骨骼以 `mirroredBones` 传输。
删除（道具用完、移除绑定、重置）会显式写入墓碑，因为 `Table.clear()` 不触发任何钩子。活动日志按保留上限
修剪，并按档案代际重置。宠物对话属于用户内容，不做镜像；手机通过 `pet_chat_list` 实时分页读取。
Live2D 与精灵资源只存在于本机，因此手机绘制 SVG 皮肤并加以说明，而不是显示警告。

### 4. 仍只在桌面可用的部分及其标注

外观定制、洞察、插件、绑定编辑、重置、桌面显示开关和皮肤修复需要桌面的文件、窗口或设置所有者。
`PET_CONSOLE_CAPABILITIES` 将它们声明为 `desktop-only`；远程模式下这些标签页仍然可见并带“桌面”徽标，
面板说明原因；绑定以只读方式显示；桌面开关变为状态标签。类型、界面和测试三者共同固定这一点
（CLAUDE.md 规则 7）。设置 → 宠物仍为 `profiles: ["desktop"]`。

## 影响

- 手机可以喂食、玩耍、对话、购物、孵化，并查看与桌面上同一只宠物的日志、图鉴和成就，XP 仍只发放一次。
- 远程操作需要桌面应用正在运行且可达；控制台会显示连接状态和数据新鲜度，并如实拒绝
  （`host-starting`、`cooling-down`、`headless-host`）。
- `pet_act` 回复中的 `grantedCoins` 是余额差值，可能包含同时发生的其他奖励。
- 写入较旧 `updatedAt` 的备份恢复不会被已有镜像游标重新拉取，这与其他所有镜像表相同。
