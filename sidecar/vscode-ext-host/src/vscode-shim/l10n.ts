/**
 * `vscode.l10n` — localisation strings.
 *
 * cognia's i18n system feeds the table; extensions get cognia's locale.
 */

import type { ShimDependencies } from "./index"

export function createL10nNamespace(deps: ShimDependencies) {
  const { connection, extensionId } = deps
  const bundle = new Map<string, string>()
  connection.onNotification(`l10n:${extensionId}:bundle`, (data) => {
    const map = data as Record<string, string>
    bundle.clear()
    for (const [k, v] of Object.entries(map ?? {})) bundle.set(k, v)
  })
  return {
    bundle,
    t(message: string, ...args: unknown[]): string {
      const translated = bundle.get(message) ?? message
      // VS Code's `t()` performs `{0}`, `{1}` substitution.
      return translated.replace(/{(\d+)}/g, (_match, idx: string) => {
        const i = Number(idx)
        return i in args ? String(args[i]) : `{${i}}`
      })
    },
    get uri() {
      return undefined as unknown
    },
  }
}
