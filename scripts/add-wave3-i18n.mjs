#!/usr/bin/env node
/**
 * Wave 3 i18n injector. Same pattern as `add-wave2-i18n.mjs` — adds the
 * sub-namespaces under the existing `mobile` top-level key idempotently.
 */

import { readFile, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, "..")
const ZH = resolve(root, "i18n/messages/zh-CN.json")
const EN = resolve(root, "i18n/messages/en.json")

const ZH_WAVE3 = {
  workflow: {
    title: "工作流",
    empty: "还没有工作流。在桌面端创建后这里就会出现。",
    runButton: "运行",
    runQueued: "已加入队列，桌面联线后将触发。",
    runFailed: "触发失败：{message}",
    activeBadge: "活跃",
    landscapeHint: "横屏阅读大图",
    runsHeader: "最近运行",
    noRuns: "暂无运行记录。",
    statusRunning: "运行中",
    statusSucceeded: "成功",
    statusFailed: "失败",
    statusCancelled: "已取消",
    statusSkipped: "跳过",
    statusWaiting: "等待",
  },
  twinSources: {
    title: "孪生数据源",
    empty: "暂无孪生数据源。点击 + 添加。",
    addCta: "添加数据源",
    pickPaste: "粘贴文本",
    pickCamera: "拍文档",
    pickFile: "选择文件",
    queuedToast: "已入队，桌面联线后将处理。",
    pasteDialogTitle: "粘贴文本",
    pasteDialogPrompt: "在此粘贴或输入要喂给孪生的文本",
    pasteCancelled: "已取消",
    statusQueued: "排队中",
    statusParsing: "解析中",
    statusEmbedding: "向量化",
    statusReady: "就绪",
    statusFailed: "失败",
  },
  twinDraftActions: {
    accept: "接受",
    reject: "拒绝",
    accepted: "已接受为 {kind}",
    rejected: "已拒绝",
    queueAcceptLabel: "接受孪生草稿",
    queueRejectLabel: "拒绝孪生草稿",
  },
  backup: {
    title: "备份与同步",
    description: "把全部本地数据加密导出到设备上。",
    exportNow: "立即备份",
    exporting: "正在打包…",
    exportSuccess: "已写入 {path}",
    exportFailed: "备份失败：{message}",
    importPick: "导入备份文件",
    importStrategy: "合并策略",
    strategySkip: "保留本地（跳过冲突）",
    strategyOverwrite: "覆盖（导入项优先）",
    strategyDuplicate: "全部新增（保留两份）",
    importing: "正在恢复…",
    importSuccess: "恢复完成",
    importFailed: "恢复失败：{message}",
    autoBackup: "自动备份",
    autoBackupHint: "在桌面联线时按设定的间隔加密自动备份。",
    autoBackupInterval: "间隔（天）",
    historyHeader: "历史",
    historyEmpty: "尚无历史记录。",
    passphraseLabel: "可选密码（留空则使用自动密钥）",
  },
  shareTarget: {
    title: "通过 cognia 分享",
    intro: "选择要把这条内容发到的会话。",
    sendCta: "发送到此会话",
    cancel: "取消",
    targetSearchPlaceholder: "搜索会话…",
    queuedToast: "已加入发送队列。",
    noConversations: "尚无可发送的会话。",
    receivedText: "收到内容",
    receivedUrl: "链接",
  },
  offline: {
    bannerOffline: "离线中 — 仍可浏览，发送将进入队列。",
    bannerReconnecting: "正在重连…",
    queuePending: "{count} 条待发送",
    staleWarning: "{count} 条消息超过 30 分钟未送达。",
    notifTitle: "cognia 离线发送中",
    notifBody: "{count} 条消息排队中。回到网络后会自动重发。",
    notifChannel: "cognia",
  },
}

const EN_WAVE3 = {
  workflow: {
    title: "Workflows",
    empty: "No workflows yet. Create one on the desktop and it appears here.",
    runButton: "Run",
    runQueued: "Queued — fires when the desktop is online again.",
    runFailed: "Trigger failed: {message}",
    activeBadge: "Active",
    landscapeHint: "Rotate for full graph",
    runsHeader: "Recent runs",
    noRuns: "No runs yet.",
    statusRunning: "Running",
    statusSucceeded: "Succeeded",
    statusFailed: "Failed",
    statusCancelled: "Cancelled",
    statusSkipped: "Skipped",
    statusWaiting: "Waiting",
  },
  twinSources: {
    title: "Twin sources",
    empty: "No twin sources yet. Tap + to add one.",
    addCta: "Add source",
    pickPaste: "Paste text",
    pickCamera: "Capture document",
    pickFile: "Pick file",
    queuedToast: "Queued — desktop will process when online.",
    pasteDialogTitle: "Paste text",
    pasteDialogPrompt: "Paste or type text to feed the twin",
    pasteCancelled: "Cancelled",
    statusQueued: "Queued",
    statusParsing: "Parsing",
    statusEmbedding: "Embedding",
    statusReady: "Ready",
    statusFailed: "Failed",
  },
  twinDraftActions: {
    accept: "Accept",
    reject: "Reject",
    accepted: "Accepted as {kind}",
    rejected: "Rejected",
    queueAcceptLabel: "Accept twin draft",
    queueRejectLabel: "Reject twin draft",
  },
  backup: {
    title: "Backup & sync",
    description: "Export all local data encrypted to this device.",
    exportNow: "Back up now",
    exporting: "Packaging…",
    exportSuccess: "Written to {path}",
    exportFailed: "Backup failed: {message}",
    importPick: "Import backup file",
    importStrategy: "Merge strategy",
    strategySkip: "Keep local (skip conflicts)",
    strategyOverwrite: "Overwrite (import wins)",
    strategyDuplicate: "Duplicate (keep both)",
    importing: "Restoring…",
    importSuccess: "Restore complete",
    importFailed: "Restore failed: {message}",
    autoBackup: "Auto backup",
    autoBackupHint: "Back up automatically while paired with desktop.",
    autoBackupInterval: "Interval (days)",
    historyHeader: "History",
    historyEmpty: "No history yet.",
    passphraseLabel: "Optional passphrase (blank uses auto key)",
  },
  shareTarget: {
    title: "Share via cognia",
    intro: "Pick a conversation to send the shared content.",
    sendCta: "Send to this chat",
    cancel: "Cancel",
    targetSearchPlaceholder: "Search conversations…",
    queuedToast: "Queued for delivery.",
    noConversations: "No conversations available yet.",
    receivedText: "Received text",
    receivedUrl: "Link",
  },
  offline: {
    bannerOffline: "Offline — sends will queue and retry automatically.",
    bannerReconnecting: "Reconnecting…",
    queuePending: "{count} queued",
    staleWarning: "{count} messages waiting > 30 min.",
    notifTitle: "cognia outbound queue",
    notifBody: "{count} messages waiting. Will retry when online.",
    notifChannel: "cognia",
  },
}

async function inject(path, additions) {
  const text = await readFile(path, "utf8")
  const json = JSON.parse(text)
  json.mobile = { ...(json.mobile ?? {}), ...additions }
  await writeFile(path, JSON.stringify(json, null, 2) + "\n", "utf8")
}

await inject(ZH, ZH_WAVE3)
await inject(EN, EN_WAVE3)
console.log("Injected Wave 3 mobile namespace into en + zh-CN")
