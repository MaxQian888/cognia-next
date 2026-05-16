#!/usr/bin/env node
/**
 * One-shot script: backfill the i18n keys that next-intl reports as
 * MISSING_MESSAGE on the scheduler / canvas / logging / inbox / chat pages.
 *
 * Adds the same dot-paths to both en.json and zh-CN.json so the i18n parity
 * gate stays green. Writes CRLF line endings to match the existing files.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, "..")
const EN_PATH = resolve(ROOT, "i18n/messages/en.json")
const ZH_PATH = resolve(ROOT, "i18n/messages/zh-CN.json")

/** Set obj[path[0]][path[1]]... = value, creating intermediate objects. */
function setDeep(obj, path, value) {
  let cur = obj
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]
    if (cur[key] == null || typeof cur[key] !== "object" || Array.isArray(cur[key])) {
      cur[key] = {}
    }
    cur = cur[key]
  }
  const leaf = path[path.length - 1]
  if (!(leaf in cur)) {
    cur[leaf] = value
  }
}

const additions = [
  // ── scheduler/dialogs/quick-workflow-trigger-dialog.tsx
  ["scheduler.quickCreateWorkflowTrigger", "Create workflow trigger", "创建工作流触发器"],
  [
    "scheduler.quickCreateWorkflowTriggerDescription",
    "Add a cron trigger to an existing workflow without leaving the scheduler.",
    "无需打开工作流编辑器，直接为已有工作流添加 cron 触发器。",
  ],
  ["scheduler.pickWorkflow", "Pick a workflow", "选择工作流"],
  ["scheduler.pickAWorkflow", "Pick a workflow", "请先选择工作流"],
  ["scheduler.cronTriggerLabel", "Cron trigger", "Cron 触发器"],
  ["scheduler.cronRequired", "Cron expression required", "请填写 Cron 表达式"],
  ["scheduler.workflowNotFound", "Workflow not found", "未找到工作流"],
  ["scheduler.cronPreset.hourly", "Every hour", "每小时"],
  ["scheduler.cronPreset.daily", "Daily at 9:00 AM", "每天 9:00"],
  ["scheduler.cronPreset.weeklyMon", "Mondays at 9:00 AM", "每周一 9:00"],
  ["scheduler.cronPreset.custom", "Custom", "自定义"],
  ["scheduler.create", "Create", "创建"],
  ["scheduler.creating", "Creating…", "创建中…"],

  // ── canvas/* (direct children + canvas.panels.moreVersions)
  ["canvas.deleteAria", "Delete {name}", "删除 {name}"],
  ["canvas.renameDocument", "Rename document", "重命名文档"],
  ["canvas.save", "Save", "保存"],
  ["canvas.panels.moreVersions", "+{count} more", "+{count} 个版本"],
  ["canvas.versionHistory", "Version history", "版本历史"],
  ["canvas.saveVersion", "Save version", "保存版本"],
  ["canvas.compare", "Compare", "对比"],
  ["canvas.cancelCompare", "Cancel compare", "取消对比"],
  [
    "canvas.compareInstructions",
    "Select two versions to compare them.",
    "选择两个版本以进行对比。",
  ],
  ["canvas.viewDiff", "View diff", "查看差异"],
  ["canvas.descriptionOptional", "Description (optional)", "描述（可选）"],
  ["canvas.descriptionPlaceholder", "Brief description of changes", "简要描述这次变更"],
  ["canvas.versionPreview", "Version preview", "版本预览"],
  ["canvas.restoreVersion", "Restore version", "恢复版本"],
  ["canvas.deleteVersion", "Delete version", "删除版本"],
  [
    "canvas.deleteVersionConfirm",
    "Are you sure you want to delete this version? This action cannot be undone.",
    "确定要删除此版本吗？此操作不可撤销。",
  ],
  ["canvas.versionComparison", "Version comparison", "版本对比"],
  ["canvas.noVersions", "No versions yet", "暂无版本"],
  ["canvas.noVersionsHint", "Save a version to keep a snapshot.", "保存版本以创建快照。"],
  ["canvas.history", "History", "历史"],
  ["canvas.current", "Current", "当前版本"],
  ["canvas.autoSave", "Auto-saved", "自动保存"],
  [
    "canvas.linesCount",
    "{count, plural, =1 {# line} other {# lines}}",
    "{count, plural, other {# 行}}",
  ],
  ["canvas.selected", "Selected", "已选择"],
  ["canvas.previewAction", "Preview", "预览"],
  ["canvas.restore", "Restore", "恢复"],

  // ── logging/log-panel-toolbar.tsx
  ["logging.panel.moreFilters.show", "Show more filters", "显示更多筛选"],
  ["logging.panel.shortcutsHint", "Keyboard shortcuts", "键盘快捷键"],
  ["logging.panel.shiftClickPrefix", "Shift-click to", "按住 Shift 单击以"],
  ["logging.panel.openDetailsPanel", "Open details panel", "打开详情面板"],
  ["logging.panel.scrollMenuLabel", "Scroll", "滚动"],
  ["logging.panel.allLevelsTab", "All", "全部"],
  ["logging.panel.shortcuts.refresh", "Refresh logs", "刷新日志"],
  ["logging.panel.shortcuts.dashboardView", "Toggle dashboard view", "切换仪表盘视图"],
  ["logging.panel.shortcuts.nextEntry", "Next entry", "下一条"],
  ["logging.panel.shortcuts.previousEntry", "Previous entry", "上一条"],
  ["logging.panel.shortcuts.expandEntry", "Expand entry", "展开条目"],
  ["logging.panel.shortcuts.openDetails", "Open details panel", "打开详情面板"],
  ["logging.panel.shortcuts.closeOrClear", "Close dialog or clear focus", "关闭对话框或清除聚焦"],
  ["logging.panel.shortcuts.showShortcuts", "Show this shortcut list", "显示快捷键列表"],

  // ── inbox/conversation-list.tsx
  ["inbox.conversationList.openSidebar", "Open conversations list", "打开会话列表"],

  // ── chat/session-cost-badge.tsx
  [
    "chat.sessionCost.tokensTitle",
    "Input: {input} · Output: {output}",
    "输入：{input} · 输出：{output}",
  ],

  // ── chat/composer.tsx — draft-review namespace
  ["chat.composer.draftReview.title", "Review pending drafts", "查看待处理草稿"],
  [
    "chat.composer.draftReview.noPendingDrafts",
    "No drafts are waiting for review.",
    "暂无等待审核的草稿。",
  ],
  ["chat.composer.draftReview.reject", "Reject", "拒绝"],
  ["chat.composer.draftReview.approve", "Approve & send", "通过并发送"],

  // ── chat/composer/bottom-toolbar.tsx
  ["chat.composer.toolbar.pluginExtensionOverflow", "More plugin actions", "更多插件操作"],

  // ── chat/composer/model-picker.tsx
  ["chat.composer.modelPicker.switchModelAria", "Switch model", "切换模型"],
  ["chat.composer.modelPicker.searchPlaceholder", "Search models…", "搜索模型…"],
  ["chat.composer.modelPicker.noProviders", "No providers configured", "尚未配置任何模型提供商"],
]

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"))
}

function writeJson(path, obj) {
  const text = JSON.stringify(obj, null, 2)
  // Match existing CRLF line endings + trailing newline.
  const crlf = text.replace(/\n/g, "\r\n") + "\r\n"
  writeFileSync(path, crlf, "utf8")
}

const en = loadJson(EN_PATH)
const zh = loadJson(ZH_PATH)

let addedEn = 0
let addedZh = 0

for (const [dotted, enValue, zhValue] of additions) {
  const path = dotted.split(".")
  const beforeEn = JSON.stringify(en)
  setDeep(en, path, enValue)
  if (JSON.stringify(en) !== beforeEn) addedEn++

  const beforeZh = JSON.stringify(zh)
  setDeep(zh, path, zhValue)
  if (JSON.stringify(zh) !== beforeZh) addedZh++
}

writeJson(EN_PATH, en)
writeJson(ZH_PATH, zh)

console.log(`Added ${addedEn} key(s) to en.json and ${addedZh} key(s) to zh-CN.json.`)
