/**
 * Headless message resolution (ADR-0059 W2 / T-A1).
 *
 * Extracted runtimes that produce user-facing strings (backup-scheduler
 * toasts, connector error messages) call `resolveMessage(key, params)` from
 * the runtime context instead of `useTranslations()`. This module builds that
 * resolver over the same aggregate message JSON `next-intl` consumes, so the
 * key namespace stays single-source.
 */

type MessageTree = { [key: string]: string | string[] | MessageTree }

export type MessageResolver = (key: string, params?: Record<string, string | number>) => string

export type HeadlessLocale = "en" | "zh-CN"

/** Dot-path lookup into the nested message tree. */
function lookup(tree: MessageTree, key: string): string | undefined {
  let node: string | string[] | MessageTree | undefined = tree
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null || Array.isArray(node)) {
      return undefined
    }
    node = node[part]
  }
  return typeof node === "string" ? node : undefined
}

/** `{param}` interpolation — the subset of ICU the extracted runtimes use. */
function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match
  )
}

/**
 * Build a resolver over an already-loaded message tree. Unknown keys resolve
 * to the key itself (same graceful degradation next-intl shows in dev) so a
 * missing translation never crashes a headless runtime.
 */
export function createMessageResolver(messages: MessageTree): MessageResolver {
  return (key, params) => {
    const template = lookup(messages, key)
    return template === undefined ? key : interpolate(template, params)
  }
}

/**
 * Load the aggregate messages for a locale and build the resolver. Static
 * import specifiers (not a template) so bundlers can resolve them.
 */
export async function loadMessageResolver(locale: HeadlessLocale = "en"): Promise<MessageResolver> {
  const messages =
    locale === "zh-CN"
      ? ((await import("@/i18n/messages/zh-CN.json")).default as unknown as MessageTree)
      : ((await import("@/i18n/messages/en.json")).default as unknown as MessageTree)
  return createMessageResolver(messages)
}
