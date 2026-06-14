/**
 * Locale-driven string bag for the live-activity card body (Feature A/B).
 *
 * The connector outbound path runs in the renderer but is NOT React, so it
 * can't call `useTranslations()`. Following the established connector
 * precedent (`lib/notifications/im-deliver.ts`, `runtime.ts` reply strings),
 * the activity-card body strings live here as a self-contained static map
 * (en + zh-CN) rather than going through next-intl. The locale is read from
 * `AppSettings.locale` at the runtime call site.
 *
 * The inbox override-form's `liveActivity` toggle (a `.tsx` surface) DOES use
 * next-intl via the i18n JSON — those keys live in
 * `inbox.conversationOverride.fields.liveActivity` in the message files.
 */
export interface ActivityI18n {
  /** Title verb while the turn is running, e.g. "Working". */
  working: string
  /** Title verb on success, e.g. "Done". */
  done: string
  /** Title verb on failure, e.g. "Failed". */
  failed: string
  /** "{count}" → tool count label fragment. */
  tools: (count: number) => string
  /** "{count}" → edit count label fragment. */
  edits: (count: number) => string
  /** "{seconds}" → elapsed seconds suffix. */
  elapsed: (seconds: number) => string
  /** "{name}" → current-tool line. */
  currentTool: (name: string) => string
  /** "{path} {added} {removed}" → terminal edit summary. */
  fileEdited: (path: string, added: number, removed: number) => string
  /** "{path} {added}" → terminal write/create summary. */
  fileCreated: (path: string, added: number) => string
  /** "{count}" → truncated-diff line count note. */
  diffTruncated: (count: number) => string
  /** Hint that a Collapsible can be expanded. */
  diffExpandHint: string
  /** Body note when a file was too large to diff. */
  diffSkipped: string
  /**
   * Compact one-line progress note for APPEND mode (adapters without `edit()`).
   * `{tools}` tool count, `{seconds}` elapsed, optional `{current}` tool name.
   */
  appendLine: (tools: number, seconds: number, current: string | null) => string
  /** Terminal one-line note for APPEND mode. `{status}` done|failed, `{seconds}` elapsed. */
  appendFinal: (status: "done" | "failed", seconds: number) => string
}

const EN: ActivityI18n = {
  working: "Working",
  done: "Done",
  failed: "Failed",
  tools: (c) => `${c} tool${c === 1 ? "" : "s"}`,
  edits: (c) => `${c} edit${c === 1 ? "" : "s"}`,
  elapsed: (s) => `${s}s`,
  currentTool: (n) => `Current: ${n}`,
  fileEdited: (p, a, r) => `${p} (+${a} −${r})`,
  fileCreated: (p, a) => `${p} (+${a})`,
  diffTruncated: (c) => `${c} more lines truncated`,
  diffExpandHint: "Tap to expand",
  diffSkipped: "File too large to diff — summary only",
  appendLine: (tools, seconds, current) =>
    `⏳ Working — ${tools} tool${tools === 1 ? "" : "s"}, ${seconds}s` +
    (current ? ` · ${current}` : ""),
  appendFinal: (status, seconds) =>
    status === "done" ? `✅ Done (${seconds}s)` : `❌ Failed (${seconds}s)`,
}

const ZH: ActivityI18n = {
  working: "处理中",
  done: "完成",
  failed: "失败",
  tools: (c) => `${c} 工具`,
  edits: (c) => `${c} 处编辑`,
  elapsed: (s) => `${s}s`,
  currentTool: (n) => `当前：${n}`,
  fileEdited: (p, a, r) => `${p}（+${a} −${r}）`,
  fileCreated: (p, a) => `${p}（+${a}）`,
  diffTruncated: (c) => `另有 ${c} 行已截断`,
  diffExpandHint: "点击展开",
  diffSkipped: "文件过大，无法生成差异——仅显示摘要",
  appendLine: (tools, seconds, current) =>
    `⏳ 处理中 —— ${tools} 工具，${seconds}s` + (current ? ` · ${current}` : ""),
  appendFinal: (status, seconds) =>
    status === "done" ? `✅ 完成（${seconds}s）` : `❌ 失败（${seconds}s）`,
}

const MAPS: Record<string, ActivityI18n> = {
  en: EN,
  "en-US": EN,
  "zh-CN": ZH,
  zh: ZH,
  "zh-Hans": ZH,
}

/**
 * Resolve the activity-card string bag for a locale. Falls back to English
 * for any unrecognized locale so an unknown setting never produces empty
 * card text.
 */
export function resolveActivityI18n(locale: string | undefined | null): ActivityI18n {
  if (locale && MAPS[locale]) return MAPS[locale]
  return EN
}
