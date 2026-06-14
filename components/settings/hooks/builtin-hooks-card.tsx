"use client"

/**
 * BuiltinHooksCard — toggles for the product-bundled built-in hooks
 * (`lib/claude/hooks/builtin-hooks.ts`). The desktop Rust runtime + the CLI
 * merge these UNDER the user's own hooks; the enable/disable state lives in
 * `builtinHookOverrides` (id → bool) inside `~/.claude/settings.json`, so it is
 * always user-scoped regardless of the per-event editor's scope tab.
 *
 * Self-contained: it reads + writes user settings directly (round-tripping the
 * full doc so other keys survive), independent of the HooksSection draft state.
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { Card } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { toast } from "@/components/ui/sonner"
import { readClaudeUserSettings, writeClaudeUserSettings } from "@/lib/claude/settings"
import {
  BUILTIN_HOOKS,
  isBuiltinHookEnabled,
  type BuiltinHookOverrides,
} from "@/lib/claude/hooks/builtin-hooks"
import { createLogger } from "@/lib/logging"

const log = createLogger("settings.hooks.builtin")

/** A user settings doc that may carry the overrides as an extra top-level key. */
type SettingsWithOverrides = Record<string, unknown> & {
  builtinHookOverrides?: BuiltinHookOverrides
}

export function BuiltinHooksCard() {
  const t = useTranslations("settings.hooks.builtin")
  const [doc, setDoc] = useState<SettingsWithOverrides | null>(null)
  const [overrides, setOverrides] = useState<BuiltinHookOverrides>({})
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const loaded = ((await readClaudeUserSettings()) ?? {}) as SettingsWithOverrides
        if (cancelled) return
        setDoc(loaded)
        setOverrides(loaded.builtinHookOverrides ?? {})
      } catch (e) {
        if (cancelled) return
        log.error("load_failed", { error: String(e) })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const toggle = useCallback(
    async (id: string, enabled: boolean) => {
      if (busy) return
      setBusy(true)
      const next = { ...overrides, [id]: enabled }
      try {
        const payload: SettingsWithOverrides = { ...(doc ?? {}), builtinHookOverrides: next }
        await writeClaudeUserSettings(payload as Parameters<typeof writeClaudeUserSettings>[0])
        setOverrides(next)
        setDoc(payload)
        toast.success(t("saved"))
      } catch (e) {
        log.error("save_failed", { id, error: String(e) })
        toast.error(t("saveError", { detail: String(e) }))
      } finally {
        setBusy(false)
      }
    },
    [busy, doc, overrides, t]
  )

  return (
    <Card
      className="space-y-3 p-3"
      data-testid="builtin-hooks-card"
      data-loaded={doc !== null ? "true" : "false"}
    >
      <div className="space-y-0.5">
        <h3 className="text-sm font-medium">{t("title")}</h3>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>
      <div className="space-y-2">
        {BUILTIN_HOOKS.map((def) => {
          const enabled = isBuiltinHookEnabled(def, overrides)
          return (
            <div
              key={def.id}
              className="flex items-start justify-between gap-3"
              data-testid={`builtin-hook-${def.id}`}
            >
              <div className="space-y-0.5">
                <Label htmlFor={`builtin-${def.id}`} className="text-xs font-medium">
                  {t(`items.${def.id}.label`)}
                </Label>
                <p className="text-[11px] text-muted-foreground">{t(`items.${def.id}.desc`)}</p>
              </div>
              <Switch
                id={`builtin-${def.id}`}
                checked={enabled}
                disabled={busy}
                onCheckedChange={(v) => void toggle(def.id, v)}
                aria-label={enabled ? t("on") : t("off")}
                data-testid={`builtin-hook-switch-${def.id}`}
              />
            </div>
          )
        })}
      </div>
    </Card>
  )
}

export default BuiltinHooksCard
