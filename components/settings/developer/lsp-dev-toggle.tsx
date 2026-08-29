"use client"

/**
 * Settings → Language Servers → "Allow unsigned LSP binaries"
 *
 * Controls `AppSettings.lsp.unsignedAllowed`. When `true`, the VS Code LSP
 * binary policy (`lib/plugin/vscode-shim/lsp-binary-policy.ts`) lets unsigned
 * LSP binaries spawn after one in-session consent prompt instead of refusing
 * them outright. Every spawn is still audit-logged.
 *
 * It previously read and wrote the pre-unification
 * `developer.unsignedLspAllowed`, which `lib/lsp/migrate-settings.ts` moves to
 * `lsp.unsignedAllowed` and then clears at app start — so the toggle wrote a
 * field the migration deleted and the policy read a field nothing set. Both
 * ends now name `lsp.unsignedAllowed`.
 *
 * Hidden in production builds (returns `null`) so the toggle never
 * appears in shipped binaries. Gate is `process.env.NODE_ENV !==
 * "production"`. `defaultIsUnsignedLspAllowed` in the policy short-circuits on
 * the same condition, so the dormancy holds on both axes.
 */

import { useTranslations } from "next-intl"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"

export interface LspDevToggleProps {
  /** Test seam — defaults to `process.env.NODE_ENV !== "production"`. */
  isDevBuild?: boolean
}

export function LspDevToggle({ isDevBuild }: LspDevToggleProps = {}) {
  const t = useTranslations("settings.developer.lsp")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)

  const showInDev =
    isDevBuild ?? (typeof process !== "undefined" && process.env.NODE_ENV !== "production")
  if (!showInDev) return null

  const current = Boolean(settings?.lsp?.unsignedAllowed)

  const onToggle = (next: boolean) => {
    void save({
      lsp: {
        ...settings?.lsp,
        servers: settings?.lsp?.servers ?? [],
        unsignedAllowed: next,
      },
    })
  }

  return (
    <div className="flex items-start justify-between gap-4 rounded-md border border-amber-300/40 bg-amber-50/40 p-4 dark:border-amber-700/40 dark:bg-amber-900/10">
      <div className="space-y-1">
        <Label htmlFor="lsp-dev-toggle" className="font-medium">
          {t("title")}
        </Label>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
        <p className="text-xs text-amber-700 dark:text-amber-300" role="note">
          {t("warning")}
        </p>
      </div>
      <Switch
        id="lsp-dev-toggle"
        checked={current}
        onCheckedChange={onToggle}
        aria-label={t("toggleAriaLabel")}
      />
    </div>
  )
}
