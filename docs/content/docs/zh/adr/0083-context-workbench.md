---
title: "0083 — 共享上下文工作台"
description: "在不删除旧能力的前提下，把 Project、Canvas、Artifact 与 Workflow 的完整右侧体验统一到资源级 Workbench。"
---

# ADR 0083 — 共享上下文工作台

**状态：** Accepted  
**日期：** 2026-07-18

## 背景

Project 文件、Canvas 文档、Artifact 与 Workflow 都已有实用的右侧工具，但生命周期、打开逻辑、尺寸、评论和插件行为分别实现，逐渐产生能力漂移：Project 的评论错误打开 Git review，Workflow 评论不可用，Artifact 的选择仅有 AI 提示。统一过程必须保留每项旧能力，并把各旧宿主保留一个小版本，作为独立回滚路径。

## 决策

以 `components/context-workbench/` 与 `lib/context-workbench/` 作为共享右侧外壳和控制器。每个业务面通过 host adapter 贡献原生面板，专用实现继续复用，不被删除或替换。

- 作用域身份使用 `window + host + resource`，不再依赖组件实例 id。活动面板、模式、宽度与 pin 状态持久化，最多保留 200 项，30 天未使用即清理。
- 桌面支持 `narrow`、真实且有边界的 `wide`，以及带焦点管理的全屏 `focus`。移动端使用全宽 Sheet，不显示无意义的宽度与 focus 控件。
- Pin 会拦截自动选择、诊断、proposal 与插件 reveal；事件改为 pending 状态和徽标。用户显式导航仍可切换面板。
- 能力由资源类型与平台真实计算。原生不可用能力显示原因；插件在缺能力或权限时默认拒绝。
- Project、Canvas、Artifact、Workflow 的全部原生面板仍可访问。现有专用聊天、proposal、Git、执行、预览、历史、格式化、文件系统、inspector、run 与 template 组件全部复用。
- `contextComments` 是评论的唯一可写表，支持资源、文本/行区间、Workflow 节点/边锚点，以及回复、reaction、resolve/reopen、revision 与 stale-anchor。Dexie v115 幂等回填 `canvasComments`；Canvas store、插件、旧 UI 与备份兼容均经 adapter 访问。
- 每个资源保留一个持久化内嵌 AI session，包括 Workflow 专用 adapter 和文件 rename/move 时的绑定迁移。

## 插件契约

插件可通过 `manifest.contextPanels` 声明可信 React 面板，也可调用 `ctx.contextPanels.register()` 命令式注册。两条路径共用命名空间 registry、懒加载 bridge、诊断、错误隔离、权限重算，以及 disable/uninstall 清理。

权限要求是 `extension:ui` 加对应的 `project:read`、`canvas:read`、`artifact:read` 或 `workflow:read`。`reveal()` 只能打开调用插件自己且适用于当前资源的面板，并遵守 pin。`getActiveContext()` 及订阅只暴露清洗后的身份、selection、revision 和 capabilities，绝不暴露资源内容。本决策不包含 sandbox Webview 面板。

Workbench 同时承载 `sidebar.right.top`、`sidebar.right.bottom`、`panel.header` 与 `panel.footer`，上下文同样经过清洗。宿主挂载时触发 `onView:context-workbench` 与资源类型专属 activation event。

## 发布与影响

`canvas`、`project`、`artifact`、`workflow` 四个 Workbench 开关独立且默认开启。此前每个业务面的右侧实现完整保留一个小版本，仅在对应回滚开关关闭时启用。短期会多一层兼容代码，但可确保共享控制器成为默认入口时不丢失任何功能。

