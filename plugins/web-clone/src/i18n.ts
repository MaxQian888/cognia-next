/**
 * Web Clone — plugin message tables.
 *
 * Registered into the host plugin-i18n registry at activate()
 * (`ctx.i18n.registerTranslations` prefixes every key with
 * `plugin.cognia-web-clone.`). `en` doubles as the fallback table inside
 * `makeTranslator` for runtimes where `ctx.i18n` is absent (tests, headless).
 */
export const WEBCLONE_I18N = {
  en: {
    intro: "Snapshot a web page to disk.",
    usage:
      "Usage: /web-clone <url> | --convert <path> [-o <output>] [-m single|bundle] " +
      "[--framework vue|react|angular|svelte|jquery] [--framework-hint vue|react|svelte] " +
      "[--extract-components] [--drafts] [--extract-shared] [--no-typescript] " +
      "[--max-assets <n>] [--concurrency <n>] [--timeout <ms>] [--max-file-size <bytes>] " +
      "[--pretty] [--private]",
    desktopOnly: "web-clone runs only on the desktop app.",
    noWorkspace: "no open workspace — open a folder in Source Control, or pass an absolute path",
    outsideWorkspace:
      '"{path}" must stay inside the workspace — remove the ".." segments, or pass a full absolute path',
    tildeUnsupported: '"{path}" uses ~ which is not expanded — pass a full absolute path',
    missingValue: "missing a value for {flag}",
    unknownFlag: "unknown flag {flag}",
    unexpectedArg: 'unexpected argument "{value}"',
    invalidValue: 'invalid value "{value}" for {flag}',
    convertWithUrl: "--convert re-runs codegen on a saved snapshot — drop the URL argument",
    resultSnapshot: "Snapshot written to {output} ({fetched}/{total} assets fetched).",
    resultSnapshotIssues:
      "Snapshot written to {output} ({fetched}/{total} fetched, {failed} failed, {skipped} skipped).",
    resultConvert: "Converted snapshot written to {output}.",
    failed: "web-clone failed: {error}",
    failedPrivateHost:
      "web-clone failed: {error} Pass --private to allow private/loopback targets.",
  },
  "zh-CN": {
    intro: "将网页快照保存到磁盘。",
    usage:
      "用法：/web-clone <url> | --convert <路径> [-o <输出>] [-m single|bundle] " +
      "[--framework vue|react|angular|svelte|jquery] [--framework-hint vue|react|svelte] " +
      "[--extract-components] [--drafts] [--extract-shared] [--no-typescript] " +
      "[--max-assets <n>] [--concurrency <n>] [--timeout <毫秒>] [--max-file-size <字节>] " +
      "[--pretty] [--private]",
    desktopOnly: "web-clone 仅可在桌面端运行。",
    noWorkspace: "没有打开的工作区——请在 Source Control 中打开文件夹，或传入绝对路径",
    outsideWorkspace: '"{path}" 必须位于工作区内——请去掉 ".." 段，或传入完整绝对路径',
    tildeUnsupported: '"{path}" 中的 ~ 不会被展开——请传入完整绝对路径',
    missingValue: "{flag} 缺少参数值",
    unknownFlag: "未知参数 {flag}",
    unexpectedArg: '无法识别的参数 "{value}"',
    invalidValue: '{flag} 的值 "{value}" 无效',
    convertWithUrl: "--convert 用于对已保存的快照重跑 codegen——请去掉 URL 参数",
    resultSnapshot: "快照已写入 {output}（已获取 {fetched}/{total} 个资源）。",
    resultSnapshotIssues:
      "快照已写入 {output}（{fetched}/{total} 成功，{failed} 失败，{skipped} 跳过）。",
    resultConvert: "转换结果已写入 {output}。",
    failed: "web-clone 失败：{error}",
    failedPrivateHost: "web-clone 失败：{error}（可加 --private 允许内网/本机地址）",
  },
} as const

export type WebCloneMessageKey = keyof (typeof WEBCLONE_I18N)["en"]

/** Interpolate `{name}` params into a message template. */
export function interpolateWebCloneMessage(
  template: string,
  params?: Record<string, string | number | boolean>
): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    params[name] !== undefined ? String(params[name]) : match
  )
}
