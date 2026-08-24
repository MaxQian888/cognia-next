---
title: "0143 — 一个控制台管所有机器"
description: "设备管理收敛为一个基于 placement 候选空间的机队视图：配对设备、远程主机、执行 worker 与本机统一为同一种行，展示旧界面持有却从未渲染的能力、在场与授权细节，并把沙盒与工作区运行时按设备接上。"
---

# ADR 0143 — 一个控制台管所有机器

**状态：** 已接受
**日期：** 2026-08-24
**相关：** [ADR-0136](./0136-cross-device-placement)、[ADR-0082](./0082-remote-development-remote-host)、[ADR-0028](./0028-sandboxed-execution)、[ADR-0060](./0060-attention-and-capture)、[ADR-0111](./0111-managed-workspace-registry)

## 背景

「设备管理」原本是两个互不相识的界面，而且两个都比它们背后的数据穷得多。

`components/settings/companion/paired-devices-card.tsx` 是一张卡片里的十列表格，360px 高、横向滚动。它**不显示任何能力**——尽管自 ADR-0060 起 `lib/companion/capability-reporter.ts` 每次连接都会写入 `pairedDevices.capabilities`。它显示 Dexie 的持久 `lastSeenAt`——尽管 `lib/companion/device-presence-registry.ts` 维护着实时事件通道、前后台状态与打开的流，并在自己的注释里写明没有任何界面渲染它。它从 `revokedAt` / `pausedAt` 推断生命周期状态——尽管 `companion_list_devices`（其注释自称「Device Center 的读取侧」）返回主机权威的 `role` 与 `status`，而它**至今零 TypeScript 调用方**。又因为 `companion_list_device_grants` 对每项授权采用 all-of 判定，一台持有 `agent.run` 却没有 `workspace.write` 的设备会返回 `false`，渲染得与从未获得任何授权的设备一模一样。

`components/settings/remote-hosts/tabs/hosts-tab.tsx` 则是一个裸 `<ul>`，把能力列表铺成一墙徽章，把特性清单逐条打印成键值行。

与此同时，`lib/placement/`（ADR-0136）早已把 `worker | paired-device | remote-host | local` 建模成同一套候选空间，维度里甚至已有 `sandbox` 与 `workspace`——但没有任何代码为这两个维度产出过值，于是 `sandbox_mismatch` 成了一个没有候选能触发的拒绝原因。「哪些机器能跑这个？」有三份互不相识的答案：工作流编辑器按 `featureManifest.features["workflow.execution"]` 过滤远程主机，teammate 绑定读 `useFleetSnapshot()`，`action.mobile.*` 按 `lastSeenAt` 排配对设备。

## 决定

### 1. 一种行，与候选空间完全同构

`lib/devices/types.ts` 定义 `DeviceRow`，其 `ref` **就是** `PlacementCandidate.ref`——同一个值，而不是两个碰巧一致的 id。`DeviceKind` 通过编译期断言与 `PlacementCandidateKind` 钉死相等：新增一种能跑活的机器时会编译失败，而不是悄悄变成一种控制台显示不了的候选。

所有推导都是纯的。`buildDeviceRows` 把每个来源都作为入参——配对行、主机的设备列表、远程主机、worker、在场、沙盒连接、时钟——于是「主机可达 / 主机不可达 / 从未上报 / 镜像不一致」的全部组合都能在单元测试里覆盖，而不必依赖一台真实的手机。

### 2. 「没告诉我们」不等于「没有」

控制台是第一个必须回答「未上报的设备长什么样」的界面。它拒绝用一整列「不具备」来回答：`absent` 表示设备答复过且确实不具备，`expected` 表示平台基线暗示具备但无人确认，`unknown` 表示我们一无所知。设备从未上报时，**没有任何一格**是 `absent`。

同一条规则也管在场：从未连接过的远程主机报 `unknown` 而不是 `offline`。把「没有信号」画成「否定答复」，就是在陈述没人给过的事实。

### 3. 主机压过镜像，且不一致要显式呈现

旧卡片用于开关的优先级——有主机答复时以主机为准，Dexie 镜像仅作为够不到主机的壳的兜底——现在同样管生命周期状态，并且不一致会被标出而不是被悄悄消化。通过 `cognia-server devices` CLI 或 Owner API 挂起的设备不会改动镜像，于是那一行读作「正常」，而它发出的每一次调用都被拒绝。

`companion_list_devices` 同时返回原始能力集合，因此 `partial` 无需扩大 Rust 接口即可推导。`GrantKind::capabilities()` 的镜像表由生成物 host command catalog 钉死：改名会让门禁失败，而不是把所有设备降级成 `partial`——那种笔误读起来像是一次安全回归。

### 4. 运行时支持由路由规则决定，而不是靠直觉

一台设备能告诉我们多少运行时信息，取决于 `protocol/companion-commands.json` 为每条命令记录的 `target`，以及 `lib/tauri/transport-routing.ts` 的分流：

- `cua_sandbox_*` 是 `target: "client"`，因此**沙盒连接永远属于运行渲染器的那台机器**。远程主机的沙盒从这里根本够不着，而空列表会让人以为它一个都没有。
- `task_workspace_environment_list` 是 `target: "execution"`，会解析到 `activeRemote ?? local`。因此工作区列表只对**当前路由目标**成立——这正是工作区需要第三种状态 `requires-activation` 而非简单是/否的原因。天真地读取它，会把远程机器的 worktree 印在本机名下。

沙盒注册表是把既有设置界面**嵌入**而非复制，因此两者不会漂移。已撤回的 `cua-desktop` 档位被列出并禁用、附上原因，而不是隐藏：仍带着该存量值的会话需要在界面上看到拒绝的解释。

### 5. 沙盒档位终于进入 placement

`buildDevicePlacement` 按维度填充 `provides`，而一个 shell 档位只有真的能执行时才计入：未注册的 microVM 适配器会让 `executeSandbox` 抛 `microvm-unavailable` 且明令禁止回退到宿主，所以通告该档位等于承诺一次注定被拒的执行。

`PlacementDimension` 新增 `host-feature`。它自成一个取值空间，理由与 `platform`、`agent` 相同：`HostFeatureId` 由 `lib/platform/host-feature-manifest.ts` 铸造，携带版本与操作列表，因此主机的 `workflow.execution` 不是平台能力，也不该满足平台能力。

### 6. 不合格候选要显示，而不是被过滤掉

`buildDeviceOptions` 返回每一个候选及其判定。工作流 run-on 选择器现在把不合格项渲染为禁用并附上其类型化的 `PlacementReason`——这正是 ADR-0136「可见降级」的界面对应物。

该目录**刻意不声明并发上限**。它回答的是「这台机器可不可以被选中」，而它对主机或手机都没有负载遥测；声明一个观察不到的 `maxUnits`，等于用一个自己编的数字去拒绝工作。

## 影响

- 设置保留配对、添加主机与 LAN 发现——那些是配置——并链接到控制台看机队。在设置里再留一份列表，就是又一个需要保持同步的界面，而落后的一定是设置里的那个。
- 移动端「我」里的入口改指 `/devices`，`app/me/devices` 已删除。`FeaturePageShell` 在 `md` 以下本就折叠为单栏 + Sheet 触发器，因此两个壳共用一棵树，不再需要移动端专用包装。旧路径不做重定向：它是应用内路由，没有深链也没有外部入口，应用之外从未有人寻址过它。
- 配对设备卡片的每一次写入都保留在 `useDeviceGrantActions` 中，且不对称性完好：开启走生物识别闸门，关闭立即生效——因为过不了生物识别的用户仍然必须能收回权限。
- Locked Use 保持三轴休眠：类型上有文档、界面上惰性且带标签、测试钉死。

## 未做

- **teammate 执行绑定仍读 `useFleetSnapshot()`。** 它需要真实的 `activeTurns` / `maxActiveTurns` 来做派发决策，而本目录拒绝声明容量；切换过去等于用编造的数字换掉真实的数字。
- **worker 不给平台能力矩阵。** 它的登记携带的是 SecurityStore 能力 id，属于另一套词表；放进平台矩阵会读错。
- **`companion_suspend_device` / `companion_resume_device` 仍未被调用。** 控制台的「暂停」仍与旧卡片一样通过 `companion_revoke_device` 写拒绝名单。迁移到规范的 `LifecycleAction` 词表会改变强制执行路径的行为，应当单独成一次改动。
- **在场信息不跨刷新存活。** `device-presence-registry` 是进程内 Map、没有订阅接口；控制台轮询它，并以 Dexie 的持久 `lastSeenAt` 打底，因此刚加载的窗口先显示持久在场，直到第一条流上报。

## 修订

- **ADR-0136** —— `PlacementDimension` 新增 `host-feature`，`sandbox` 维度获得第一个生产者。`PlacementReason` 未变，仍为只增不改。
