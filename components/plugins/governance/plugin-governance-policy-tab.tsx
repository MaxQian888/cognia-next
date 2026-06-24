"use client"

// Plugin policy controls, consolidated under the workspace's Governance
// section (previously a tab inside Settings → Plugins). One conceptual
// "security" surface: governance mode, signature requirement, trusted
// publishers, auto-update, and strict sandboxing. Persistence is unchanged —
// the four governance/signature/update flags live in localStorage via the
// shared `plugins-policy-storage` helpers; strict-sandboxing posture lives in
// the settings store (Dexie). Every toggle re-applies to the live runtime so
// changes take effect without a reload.

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { Card } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { useSettingsStore } from "@/stores/settings"
import { applyPluginPolicyToRuntime } from "@/lib/plugin/core/policy-runtime"
import {
  readPolicy,
  writePolicy,
  type PluginsPolicy,
} from "@/lib/plugin/core/plugins-policy-storage"

export function PluginGovernancePolicyTab() {
  const t = useTranslations("plugins.governance.policy")
  const pluginSecurityPosture = useSettingsStore((s) => s.settings?.pluginSecurityPosture)
  const setPluginSecurityPosture = useSettingsStore((s) => s.setPluginSecurityPosture)
  const strictPosture = (pluginSecurityPosture ?? "balanced") === "strict"
  const [policy, setPolicy] = useState<PluginsPolicy>(() => readPolicy())

  // Re-apply the persisted policy to the live runtime on mount. The plugin
  // store boot path also applies it; re-applying is idempotent and covers the
  // case where the workspace mounts before a plugin has activated.
  useEffect(() => {
    applyPluginPolicyToRuntime(policy)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const update = (patch: Partial<PluginsPolicy>) => {
    const next = { ...policy, ...patch }
    setPolicy(next)
    writePolicy(next)
    applyPluginPolicyToRuntime(next)
  }

  return (
    <Card className="p-4 space-y-4" data-testid="plugin-governance-policy">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1 min-w-0">
          <Label htmlFor="plugins-governance-mode">{t("governance")}</Label>
          <p className="text-xs text-muted-foreground">{t("governanceHint")}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{t("governanceWarn")}</span>
          <Switch
            id="plugins-governance-mode"
            checked={policy.governance === "block"}
            onCheckedChange={(checked) => update({ governance: checked ? "block" : "warn" })}
          />
          <span className="text-xs text-muted-foreground">{t("governanceBlock")}</span>
        </div>
      </div>

      <div className="flex items-start justify-between gap-4 border-t pt-4">
        <div className="space-y-1 min-w-0">
          <Label htmlFor="plugins-signature-required">{t("signatureRequired")}</Label>
          <p className="text-xs text-muted-foreground">{t("signatureRequiredHint")}</p>
        </div>
        <Switch
          id="plugins-signature-required"
          checked={policy.signatureRequired}
          onCheckedChange={(checked) => update({ signatureRequired: checked })}
        />
      </div>

      <div className="flex items-start justify-between gap-4 border-t pt-4">
        <div className="space-y-1 min-w-0">
          <Label htmlFor="plugins-trusted-publishers-only">{t("trustedPublishersOnly")}</Label>
          <p className="text-xs text-muted-foreground">{t("trustedPublishersOnlyHint")}</p>
        </div>
        <Switch
          id="plugins-trusted-publishers-only"
          checked={policy.trustedPublishersOnly}
          onCheckedChange={(checked) => update({ trustedPublishersOnly: checked })}
        />
      </div>

      <div className="flex items-start justify-between gap-4 border-t pt-4">
        <div className="space-y-1 min-w-0">
          <Label htmlFor="plugins-auto-update">{t("autoUpdate")}</Label>
          <p className="text-xs text-muted-foreground">{t("autoUpdateHint")}</p>
        </div>
        <Switch
          id="plugins-auto-update"
          checked={policy.autoUpdate}
          onCheckedChange={(checked) => update({ autoUpdate: checked })}
        />
      </div>

      <div className="flex items-start justify-between gap-4 border-t pt-4">
        <div className="space-y-1 min-w-0">
          <Label htmlFor="plugins-security-posture">{t("securityPosture")}</Label>
          <p className="text-xs text-muted-foreground">{t("securityPostureHint")}</p>
        </div>
        <Switch
          id="plugins-security-posture"
          checked={strictPosture}
          onCheckedChange={(checked) =>
            void setPluginSecurityPosture(checked ? "strict" : "balanced")
          }
        />
      </div>

      <div className="border-t pt-4 text-xs text-muted-foreground">{t("rateLimitsNote")}</div>
    </Card>
  )
}
