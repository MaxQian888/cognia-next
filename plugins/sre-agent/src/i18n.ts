/**
 * Declarative i18n bundle. Overlaid into the host next-intl tree under
 * `plugin.sre-agent.*` on enable (via `manifest.i18n.locales`), and read
 * directly by `usePluginT()`. Keys are authored fully-prefixed here; the hook
 * passes them unprefixed and adds the `plugin.sre-agent.` prefix.
 *
 * `i18n.test.ts` pins en/zh parity AND that every key the panel actually asks
 * for exists — `lint:i18n` cannot see a key built at runtime, which is exactly
 * how a status label ships as its own raw key string.
 */

export const I18N_MESSAGES = {
  en: {
    "plugin.sre-agent.panel.title": "SRE incidents",
    "plugin.sre-agent.panel.readOnly": "Read-only — never changes production",
    "plugin.sre-agent.panel.unavailable.title": "The SRE runtime is not wired",
    "plugin.sre-agent.panel.unavailable.body":
      "The plugin activated without an evidence runtime, so nothing can be queried. Disable and re-enable the plugin, then reopen this panel.",
    "plugin.sre-agent.panel.storageUnavailable":
      "Incidents cannot be saved in this shell, so this investigation is lost when the panel closes.",
    "plugin.sre-agent.panel.back": "All incidents",
    "plugin.sre-agent.panel.loading": "Loading incidents…",

    "plugin.sre-agent.list.filter.investigating": "Open {count}",
    "plugin.sre-agent.list.filter.unconfirmed": "Needs confirmation {count}",
    "plugin.sre-agent.list.filter.closed": "Closed {count}",
    "plugin.sre-agent.list.evidenceCount": "{count} pinned",
    "plugin.sre-agent.list.noneInFilter": "Nothing in this group.",
    "plugin.sre-agent.list.empty.title": "No incident is being investigated",
    "plugin.sre-agent.list.empty.body":
      "Open one from the conversation in front of you, and the panel investigates against the window you name.",
    "plugin.sre-agent.list.empty.create": "Open an incident here",
    "plugin.sre-agent.list.empty.fromAlert": "Open from the bundled alert",

    "plugin.sre-agent.status.investigating": "Investigating",
    "plugin.sre-agent.status.unconfirmed": "Needs confirmation",
    "plugin.sre-agent.status.resolved": "Resolved",
    "plugin.sre-agent.status.dismissed": "Dismissed",

    "plugin.sre-agent.severity.info": "info",
    "plugin.sre-agent.severity.warning": "warning",
    "plugin.sre-agent.severity.critical": "critical",

    "plugin.sre-agent.phase.scope": "Scope",
    "plugin.sre-agent.phase.evidence": "Evidence",
    "plugin.sre-agent.phase.attribution": "Attribution",
    "plugin.sre-agent.phase.conclusion": "Conclusion",
    "plugin.sre-agent.phase.label": "Investigation phase",

    "plugin.sre-agent.agent.observed": "Agent pinned evidence {count} times",
    "plugin.sre-agent.agent.idle":
      "No agent activity yet — ask the SRE Incident Diagnostician in the conversation to investigate.",
    "plugin.sre-agent.agent.pinLatest": "Pin the agent's latest {count}",

    "plugin.sre-agent.lens.title": "Log lens",
    "plugin.sre-agent.lens.expand": "Widen the panel",
    "plugin.sre-agent.lens.records": "{count} records",
    "plugin.sre-agent.lens.errors": "{count} errors",
    "plugin.sre-agent.lens.patterns": "Templates",
    "plugin.sre-agent.lens.new": "new",
    "plugin.sre-agent.lens.noBaseline": "no baseline",
    "plugin.sre-agent.lens.pinGroup": "Pin group",
    "plugin.sre-agent.lens.pinned": "Pinned",
    "plugin.sre-agent.lens.empty": "No log in this window.",
    "plugin.sre-agent.lens.outsideCoverage":
      "This backend only holds {start} to {end}; the window above falls outside it.",
    "plugin.sre-agent.lens.failed": "The backend refused the query: {message}",
    "plugin.sre-agent.lens.loading": "Querying…",

    "plugin.sre-agent.timeline.title": "Call-chain timeline",
    "plugin.sre-agent.timeline.empty":
      "No timeline yet. The diagnostician drafts one, then it is checked against the evidence it cites.",
    "plugin.sre-agent.timeline.validate": "Check against evidence",
    "plugin.sre-agent.timeline.unchecked": "Not checked yet",
    "plugin.sre-agent.timeline.ok": "Every row cites evidence that exists",
    "plugin.sre-agent.timeline.failed": "{count} problems",
    "plugin.sre-agent.timeline.issueGeneral": "Problems with the draft as a whole",

    "plugin.sre-agent.conclusion.title": "Conclusion",
    "plugin.sre-agent.conclusion.findings": "Findings",
    "plugin.sre-agent.conclusion.recommendations": "Recommended actions",
    "plugin.sre-agent.conclusion.none": "Nothing drafted yet.",
    "plugin.sre-agent.conclusion.accept": "Accept conclusion",
    "plugin.sre-agent.conclusion.accepted": "Accepted",
    "plugin.sre-agent.conclusion.blocked.timeline.empty": "Draft a timeline first.",
    "plugin.sre-agent.conclusion.blocked.validation.missing":
      "Check the timeline against its evidence first.",
    "plugin.sre-agent.conclusion.blocked.validation.failed": "Fix the validation problems first.",
    "plugin.sre-agent.conclusion.blocked.status.closed": "This incident is already closed.",

    "plugin.sre-agent.sources.title": "Ingest sources",
    "plugin.sre-agent.sources.status.healthy": "healthy",
    "plugin.sre-agent.sources.status.lagging": "lagging",
    "plugin.sre-agent.sources.status.stalled": "stalled",
    "plugin.sre-agent.sources.status.static": "bundled",
    "plugin.sre-agent.sources.lag": "{ms} ms behind",
    "plugin.sre-agent.sources.noLag": "no live pipeline",
    "plugin.sre-agent.sources.records": "{count} records",

    "plugin.sre-agent.actions.confirm": "Investigate",
    "plugin.sre-agent.actions.dismiss": "Dismiss",
    "plugin.sre-agent.actions.reopen": "Reopen",
    "plugin.sre-agent.actions.delete": "Delete incident",
  },
  "zh-CN": {
    "plugin.sre-agent.panel.title": "SRE 事件",
    "plugin.sre-agent.panel.readOnly": "只读 · 不改动生产",
    "plugin.sre-agent.panel.unavailable.title": "SRE 运行时未接入",
    "plugin.sre-agent.panel.unavailable.body":
      "插件激活时没有拿到证据运行时，任何查询都无法发出。请停用后重新启用插件，再打开这个面板。",
    "plugin.sre-agent.panel.storageUnavailable": "当前壳内无法保存事件，关闭面板后这次调查会丢失。",
    "plugin.sre-agent.panel.back": "全部事件",
    "plugin.sre-agent.panel.loading": "正在读取事件…",

    "plugin.sre-agent.list.filter.investigating": "进行中 {count}",
    "plugin.sre-agent.list.filter.unconfirmed": "待确认 {count}",
    "plugin.sre-agent.list.filter.closed": "已关闭 {count}",
    "plugin.sre-agent.list.evidenceCount": "已取 {count} 条",
    "plugin.sre-agent.list.noneInFilter": "这一组是空的。",
    "plugin.sre-agent.list.empty.title": "当前没有进行中的事件",
    "plugin.sre-agent.list.empty.body": "从眼前这个会话建一个，面板会按你给的时间窗去查。",
    "plugin.sre-agent.list.empty.create": "从当前会话建事件",
    "plugin.sre-agent.list.empty.fromAlert": "用内置告警建事件",

    "plugin.sre-agent.status.investigating": "调查中",
    "plugin.sre-agent.status.unconfirmed": "待确认",
    "plugin.sre-agent.status.resolved": "已结案",
    "plugin.sre-agent.status.dismissed": "已忽略",

    "plugin.sre-agent.severity.info": "提示",
    "plugin.sre-agent.severity.warning": "警告",
    "plugin.sre-agent.severity.critical": "严重",

    "plugin.sre-agent.phase.scope": "范围",
    "plugin.sre-agent.phase.evidence": "取证",
    "plugin.sre-agent.phase.attribution": "归因",
    "plugin.sre-agent.phase.conclusion": "结论",
    "plugin.sre-agent.phase.label": "调查阶段",

    "plugin.sre-agent.agent.observed": "Agent 已取证 {count} 次",
    "plugin.sre-agent.agent.idle": "还没有 Agent 活动 — 在对话里让 SRE 诊断员开始调查。",
    "plugin.sre-agent.agent.pinLatest": "把 Agent 最近取的 {count} 条加入",

    "plugin.sre-agent.lens.title": "日志透镜",
    "plugin.sre-agent.lens.expand": "加宽面板",
    "plugin.sre-agent.lens.records": "{count} 条",
    "plugin.sre-agent.lens.errors": "错误 {count}",
    "plugin.sre-agent.lens.patterns": "日志模板",
    "plugin.sre-agent.lens.new": "新增",
    "plugin.sre-agent.lens.noBaseline": "无基线",
    "plugin.sre-agent.lens.pinGroup": "整组取证",
    "plugin.sre-agent.lens.pinned": "已取",
    "plugin.sre-agent.lens.empty": "这个时间窗里没有日志。",
    "plugin.sre-agent.lens.outsideCoverage":
      "该后端只有 {start} 到 {end} 的数据，上面的时间窗落在范围外。",
    "plugin.sre-agent.lens.failed": "后端拒绝了这次查询：{message}",
    "plugin.sre-agent.lens.loading": "查询中…",

    "plugin.sre-agent.timeline.title": "调用链时间线",
    "plugin.sre-agent.timeline.empty": "还没有时间线。诊断员先给出草稿，再拿它引用的证据逐行校验。",
    "plugin.sre-agent.timeline.validate": "按证据校验",
    "plugin.sre-agent.timeline.unchecked": "尚未校验",
    "plugin.sre-agent.timeline.ok": "每一行引用的证据都存在",
    "plugin.sre-agent.timeline.failed": "{count} 处问题",
    "plugin.sre-agent.timeline.issueGeneral": "草稿整体的问题",

    "plugin.sre-agent.conclusion.title": "结论",
    "plugin.sre-agent.conclusion.findings": "关键发现",
    "plugin.sre-agent.conclusion.recommendations": "建议动作",
    "plugin.sre-agent.conclusion.none": "还没有草稿。",
    "plugin.sre-agent.conclusion.accept": "接受结论",
    "plugin.sre-agent.conclusion.accepted": "已接受",
    "plugin.sre-agent.conclusion.blocked.timeline.empty": "先给出时间线。",
    "plugin.sre-agent.conclusion.blocked.validation.missing": "先按证据校验时间线。",
    "plugin.sre-agent.conclusion.blocked.validation.failed": "先修掉校验里的问题。",
    "plugin.sre-agent.conclusion.blocked.status.closed": "该事件已经关闭。",

    "plugin.sre-agent.sources.title": "采集来源",
    "plugin.sre-agent.sources.status.healthy": "正常",
    "plugin.sre-agent.sources.status.lagging": "积压",
    "plugin.sre-agent.sources.status.stalled": "已停",
    "plugin.sre-agent.sources.status.static": "内置样本",
    "plugin.sre-agent.sources.lag": "落后 {ms} ms",
    "plugin.sre-agent.sources.noLag": "无实时管道",
    "plugin.sre-agent.sources.records": "{count} 条",

    "plugin.sre-agent.actions.confirm": "立案调查",
    "plugin.sre-agent.actions.dismiss": "忽略",
    "plugin.sre-agent.actions.reopen": "重新打开",
    "plugin.sre-agent.actions.delete": "删除事件",
  },
} as const
