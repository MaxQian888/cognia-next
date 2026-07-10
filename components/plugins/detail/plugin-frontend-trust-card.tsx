"use client"

// Frontend trust affordance (ADR 0013 — pragmatic trust model).
//
// `frontend`/`hybrid` plugins execute their JavaScript un-sandboxed in the
// renderer realm, so a plugin from an untrusted source
// (`local`/`marketplace`/`git`) is refused at load until the user explicitly
// trusts it. This card is the escape hatch: it renders ONLY for that case
// (renderer-JS type + untrusted source) and toggles the persisted per-plugin
// trust grant via the PluginManager. WASM / python / vscode-extension plugins
// run in isolated hosts and never show this card.

import { useState } from "react"
import { useTranslations } from "next-intl"
import { ShieldAlert } from "lucide-react"

import { Card } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { getPluginManager } from "@/lib/plugin/core/manager"
import { isInherentlyTrustedFrontendSource } from "@/lib/plugin/core/plugins-policy-storage"
import type { PluginSource, PluginType } from "@/types/plugin"

const RENDERER_JS_TYPES: readonly PluginType[] = ["frontend", "hybrid"]

const SWITCH_ID = "plugin-frontend-trust-switch"

export function PluginFrontendTrustCard({
  pluginId,
  type,
  source,
}: {
  pluginId: string
  type: PluginType
  source: PluginSource
}) {
  const t = useTranslations("plugins.detail.frontendTrust")
  // Only renderer-JS plugins from an untrusted source need an explicit grant.
  // Computed before the state init so `getPluginManager()` (heavy singleton) is
  // touched only when this card will actually render.
  const applicable = RENDERER_JS_TYPES.includes(type) && !isInherentlyTrustedFrontendSource(source)
  const [trusted, setTrusted] = useState(() =>
    applicable ? getPluginManager().isFrontendTrusted(pluginId) : false
  )

  if (!applicable) {
    return null
  }

  const onToggle = (next: boolean) => {
    getPluginManager().setFrontendTrust(pluginId, next)
    setTrusted(next)
  }

  return (
    <Card
      className="border-amber-500/40 bg-amber-500/5 p-3"
      data-testid="plugin-frontend-trust-card"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-1.5">
            <ShieldAlert className="size-4 text-amber-500" aria-hidden="true" />
            <Label htmlFor={SWITCH_ID} className="text-sm font-semibold">
              {t("title")}
            </Label>
          </div>
          <p className="text-xs text-muted-foreground">{t("description")}</p>
          {!trusted ? (
            <p className="text-xs font-medium text-amber-600">{t("blockedHint")}</p>
          ) : null}
        </div>
        <Switch
          id={SWITCH_ID}
          checked={trusted}
          onCheckedChange={onToggle}
          aria-label={t("switchAria")}
        />
      </div>
    </Card>
  )
}
