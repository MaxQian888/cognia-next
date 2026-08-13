# Pi Agent bypass / permission modes 调研

日期：2026-08-13

## 结论

有：[`pi-permission-modes@2.2.0`](https://www.npmjs.com/package/pi-permission-modes/v/2.2.0) 正好提供类似 Codex/Claude Code 的状态切换，并内置真正的无确认、无沙箱 **YOLO** 模式。

但它与当前已经安装的 [`@gotgenes/pi-permission-system@25.0.0`](https://www.npmjs.com/package/@gotgenes/pi-permission-system/v/25.0.0) 都会拦截工具、Bash、文件和 Skill 调用，属于两套权限引擎。**建议二选一，不要同时启用。**

- 想要 `Default / Plan / Build / YOLO` 一键切换：用 `pi-permission-modes` 替换现有权限系统。
- 只想临时免去 `ask` 提示，同时继续保留明确的 `deny`：现有 `@gotgenes/pi-permission-system` 已有 `yoloMode`，不必安装新插件。

## `pi-permission-modes@2.2.0`

官方默认状态为：

| 状态 | 默认行为 |
| --- | --- |
| `default` | Bash、Edit、Write 均确认；项目内 Bash 仍在 OS 沙箱运行 |
| `plan` | 只读 Bash 沙箱；仅允许项目内 Markdown 变更 |
| `build` | 项目内读写和 Bash 无确认，但 Bash 仍在 OS 沙箱内 |
| `yolo` | 无确认、无 OS 沙箱、跳过 protected-path backstop，以当前用户的完整权限运行 |

这些行为由包内的[固定版本默认配置](https://github.com/wynainfo/pi-permission-modes/blob/v2.2.0/permission-mode.defaults.json)定义；安全边界和 YOLO 风险见该版本的[官方安全模型](https://github.com/wynainfo/pi-permission-modes/blob/v2.2.0/SECURITY.md)。

精确操作：

- `alt+m`：按 `cycleOrder` 循环状态。
- `/perm <mode>`：直接切换，例如 `/perm build`、`/perm yolo`。
- `/perm`：没有有效参数时切换到下一个状态。
- `pi --perm yolo`：以指定状态启动。
- `/perm init`：生成全局可编辑配置。
- `/perm clear-approvals`：清除本次会话的临时批准。
- `/sandbox`：显示当前沙箱状态。
- `alt+n` 或 `/net open|restrict`：仅切换沙箱网络过滤，不等同于 YOLO。

命令注册、循环实现和状态恢复逻辑可直接核对[版本 2.2.0 源码](https://github.com/wynainfo/pi-permission-modes/blob/v2.2.0/src/index.ts#L195-L303)。状态保存在 Pi session 中，可跨 `/reload`、resume 和 branch navigation 恢复；活动状态会显示在 footer。[官方 README](https://github.com/wynainfo/pi-permission-modes/blob/v2.2.0/README.md#modes)

### 可以让 bypass 不参与循环

可以。`cycleOrder` 只决定 `alt+m` 和无参数 `/perm` 的循环列表；`/perm yolo` 会按 `modes` 注册表直接查找，因此即使 `yolo` 不在 `cycleOrder`，仍可显式进入：

```json
{
  "defaultMode": "default",
  "cycleOrder": ["default", "plan", "build"]
}
```

全局配置位置为：

```text
~/.pi/agent/permission-mode/permission-mode.json
```

因此推荐的交互是：平时 `alt+m` 只在安全状态间循环，需要完全 bypass 时明确输入 `/perm yolo`；退出时输入 `/perm build` 或 `/perm default`。配置分层和自定义模式规则见[官方配置文档](https://github.com/wynainfo/pi-permission-modes/blob/v2.2.0/README.md#configuration)。

### macOS 与 worktree 限制

- macOS 使用系统自带的 `sandbox-exec`，无需额外系统包。
- 但是当项目根目录的 `.git` 是文件时——典型的 Git worktree 或 submodule——2.2.0 会在平台无关的初始化路径上直接关闭 OS 沙箱，Default/Plan/Build 退化为逐次确认。实现见[官方源码](https://github.com/wynainfo/pi-permission-modes/blob/v2.2.0/src/sandbox.ts#L185-L229)。
- 当前配置中的 `@narumitw/pi-worktree` 会创建这种 `.git` 文件式 worktree，因此 worker 子任务无法获得该插件的 Build/Plan OS 沙箱；YOLO 本来就是无沙箱，不受这一退化影响。
- 在普通 clone 的 macOS 主工作区中，OS 沙箱可以正常初始化。

## 与当前 `@gotgenes/pi-permission-system@25.0.0` 的差异

现有插件其实已经有 YOLO 开关：运行无参数 `/permission-system` 打开设置面板，将 **YOLO mode** 切为 `on`。状态栏会显示 `yolo`。其他精确命令只有：

```text
/permission-system show
/permission-system path
/permission-system reset
/permission-system help
```

它没有 `/yolo`、`/bypass`、模式循环或专用快捷键；开关通过设置面板修改并持久化。命令与面板定义见[25.0.0 源码](https://github.com/gotgenes/pi-packages/blob/pi-permission-system-v25.0.0/packages/pi-permission-system/src/config-modal.ts)。

更关键的是，它的 `yoloMode` **只把匹配结果中的 `ask` 重写为 `allow`**；明确配置的 `deny` 仍然阻止操作。因此它是“免确认”，不是完全权限绕过。[官方运行时配置说明](https://github.com/gotgenes/pi-packages/blob/pi-permission-system-v25.0.0/packages/pi-permission-system/docs/configuration.md#runtime-knobs)与[决策源码](https://github.com/gotgenes/pi-packages/blob/pi-permission-system-v25.0.0/packages/pi-permission-system/src/permission-manager.ts#L288-L298)都明确体现这一点。

## 为什么不应共存

两者都会注册 `tool_call`、`input`、`before_agent_start` 等拦截，并都会影响活动工具集合：

- 任一引擎返回 block，调用仍会被阻止；一个插件进入 YOLO 不能绕过另一个插件的 `deny` 或 `ask`。
- 两套 `ask` 规则可能形成重复确认。
- 两边都会控制工具可见性，加载顺序可能让界面中的工具集合反复被重设；即使工具重新显示，另一引擎的执行时 gate 仍可能阻止它。
- `pi-permission-modes` 自带 Plan Mode；当前 `@narumitw/pi-plan-mode` 也会锁定工具、注入计划提示并拦截调用。两种 Plan 同时开启会产生双重状态与工具恢复顺序问题。
- `pi-permission-modes` 不具备现有 gotgenes 组合针对 `@gotgenes/pi-subagents` 的原生逐 Agent policy 和 `ask` 转发集成；它仅通过环境变量尽力把活动模式传给子进程，未收到模式的 headless child 会退回最严格的沙箱模式。[官方安全说明](https://github.com/wynainfo/pi-permission-modes/blob/v2.2.0/SECURITY.md#known-limitations-read-these)

## 推荐决策

当前这套配置更适合先保留 `@gotgenes/pi-permission-system`，直接通过 `/permission-system` 打开 `yoloMode`：它不会绕过敏感文件、危险删除和强推等明确 `deny`，也保留现有 subagent 权限转发。

如果明确需要“一条命令进入真正 bypass”，再执行一次有意识的替换：卸载 gotgenes 权限系统，并将现有独立 Plan 插件一并纳入迁移评估，然后安装 `pi-permission-modes@2.2.0`，把 `cycleOrder` 配成不含 `yolo`，只允许通过 `/perm yolo` 显式进入。不要把两套权限引擎同时加载作为长期配置。

