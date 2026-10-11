"use client"

// Frontend trust affordance (ADR 0013 — pragmatic trust model).
//
// `frontend`/`hybrid` plugins execute their JavaScript un-sandboxed in the
// renderer realm, so a plugin from an untrusted source
// (`local`/`marketplace`/`git`) is refused at load until the user explicitly
// trusts it. This card is the escape hatch: it renders ONLY for that case
// (renderer-JS type + untrusted source) and toggles the persisted per-plugin
// trust grant via the PluginManager. WASM and python plugins run in isolated
// hosts and never show this card.
//
// A VS Code extension shows it, with its own wording, when no Open VSX
// signature vouches for it (a dropped `.vsix`, or one signed by a key Cognia
// does not pin): it runs with real file, network and process access, so it
// starts only once the user trusts it.
//
// Rendered as a flat callout (left amber rule, heading, text, switch) at the
// top of the Permissions tab, never as a bordered card.

import { useState } from "react"
import { useTranslations } from "next-intl"
import { ShieldAlert } from "lucide-react"

import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { getPluginManager } from "@/lib/plugin/core/manager"
import { isInherentlyTrustedFrontendSource } from "@/lib/plugin/core/plugins-policy-storage"
import type { PluginSource, PluginType } from "@/types/plugin"

const RENDERER_JS_TYPES: readonly PluginType[] = ["frontend", "hybrid"]

const SWITCH_ID = "plugin-frontend-trust-switch"
const TITLE_ID = "plugin-frontend-trust-title"

export function PluginFrontendTrustCard({
  pluginId,
  type,
  source,
  signedByOpenVsx = false,
}: {
  pluginId: string
  type: PluginType
  source: PluginSource
  /** A VS Code extension whose Open VSX signature was verified at install. */
  signedByOpenVsx?: boolean
}) {
  const t = useTranslations("plugins.detail.frontendTrust")
  const vscode = type === "vscode-extension"
  // Only renderer-JS plugins and unsigned VS Code extensions from an
  // untrusted source need an explicit grant. Computed before the state init
  // so `getPluginManager()` (heavy singleton) is touched only when this card
  // will actually render.
  const applicable =
    !isInherentlyTrustedFrontendSource(source) &&
    (vscode ? !signedByOpenVsx : RENDERER_JS_TYPES.includes(type))
  const key = (name: "title" | "description" | "blockedHint" | "switchAria") =>
    vscode ? (`vscode.${name}` as const) : name
  const [trusted, setTrusted] = useState(() =>
    applicable ? getPluginManager().isFrontendTrusted(pluginId) : false
  )

  if (!applicable) {
    return null
  }

  const onToggle = (next: boolean) => {
    // Fire-and-forget: revoking also disables a running plugin behind the
    // manager's lifecycle lock; the switch reflects the grant immediately.
    void getPluginManager().setFrontendTrust(pluginId, next)
    setTrusted(next)
  }

  // A flat callout, not a card: the Permissions tab owns the pane, so a boxed
  // notice would be a frame inside a frame. The amber rule carries the
  // warning; the switch is the action.
  return (
    <section
      className="@container border-l-2 border-amber-500 py-1 pl-3"
      data-testid="plugin-frontend-trust-card"
      aria-labelledby={TITLE_ID}
    >
      <div className="flex items-start justify-between gap-3 @sm:gap-4">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-1.5">
            <ShieldAlert className="size-4 shrink-0 text-amber-500" aria-hidden="true" />
            <Label id={TITLE_ID} htmlFor={SWITCH_ID} className="text-sm font-semibold">
              {t(key("title"))}
            </Label>
          </div>
          <p className="text-xs text-muted-foreground">{t(key("description"))}</p>
          {!trusted ? (
            <p className="text-xs font-medium text-amber-600 dark:text-amber-400">
              {t(key("blockedHint"))}
            </p>
          ) : null}
        </div>
        <Switch
          id={SWITCH_ID}
          className="mt-0.5 shrink-0"
          checked={trusted}
          onCheckedChange={onToggle}
          aria-label={t(key("switchAria"))}
        />
      </div>
    </section>
  )
}
