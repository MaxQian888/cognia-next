"use client"

// Plugin policy controls, consolidated under the workspace's Governance
// section (previously a tab inside Settings → Plugins). One conceptual
// "security" surface: governance mode, signature requirement, trusted
// publishers, auto-update, and strict sandboxing. Persistence is unchanged —
// the four governance/signature/update flags live in localStorage via the
// shared `plugins-policy-storage` helpers; strict-sandboxing posture lives in
// the settings store (Dexie). Every toggle re-applies to the live runtime so
// changes take effect without a reload.
//
// Laid out as one flat list of setting rows divided by hairlines — no card:
// the governance pane is already the surface, and a box around the list only
// added a border and padding. Rows stack their control under the text in a
// narrow pane and sit beside it once the PANE (anonymous `@container`, not the
// viewport) has room.
//
// The four policy flags come from localStorage synchronously. Strict
// sandboxing lives in the settings store, which loads asynchronously; until
// it has, that row shows a placeholder instead of a switch that would read
// "off" for a user who turned it on.

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import type { ReactNode } from "react"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
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
  const settingsLoaded = useSettingsStore((s) => s.loaded)
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
    <div className="@container" data-testid="plugin-governance-policy">
      <div className="divide-y">
        <PolicyRow id="plugins-governance-mode" label={t("governance")} hint={t("governanceHint")}>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{t("governanceWarn")}</span>
            <Switch
              id="plugins-governance-mode"
              checked={policy.governance === "block"}
              onCheckedChange={(checked) => update({ governance: checked ? "block" : "warn" })}
            />
            <span className="text-xs text-muted-foreground">{t("governanceBlock")}</span>
          </div>
        </PolicyRow>

        <PolicyRow
          id="plugins-signature-required"
          label={t("signatureRequired")}
          hint={t("signatureRequiredHint")}
        >
          <Switch
            id="plugins-signature-required"
            checked={policy.signatureRequired}
            onCheckedChange={(checked) => update({ signatureRequired: checked })}
          />
        </PolicyRow>

        <PolicyRow
          id="plugins-trusted-publishers-only"
          label={t("trustedPublishersOnly")}
          hint={t("trustedPublishersOnlyHint")}
        >
          <Switch
            id="plugins-trusted-publishers-only"
            checked={policy.trustedPublishersOnly}
            onCheckedChange={(checked) => update({ trustedPublishersOnly: checked })}
          />
        </PolicyRow>

        <PolicyRow id="plugins-auto-update" label={t("autoUpdate")} hint={t("autoUpdateHint")}>
          <Switch
            id="plugins-auto-update"
            checked={policy.autoUpdate}
            onCheckedChange={(checked) => update({ autoUpdate: checked })}
          />
        </PolicyRow>

        <PolicyRow
          id="plugins-security-posture"
          label={t("securityPosture")}
          hint={t("securityPostureHint")}
        >
          {settingsLoaded ? (
            <Switch
              id="plugins-security-posture"
              checked={strictPosture}
              onCheckedChange={(checked) =>
                void setPluginSecurityPosture(checked ? "strict" : "balanced")
              }
            />
          ) : (
            <span role="status" className="inline-flex items-center">
              <Skeleton
                className="h-[1.15rem] w-8 rounded-full"
                data-testid="plugin-governance-posture-loading"
              />
              <span className="sr-only">{t("securityPostureLoading")}</span>
            </span>
          )}
        </PolicyRow>

        <p className="py-3 text-xs text-muted-foreground">{t("rateLimitsNote")}</p>
      </div>
    </div>
  )
}

function PolicyRow({
  id,
  label,
  hint,
  children,
}: {
  id: string
  label: string
  hint: string
  children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-2 py-3 first:pt-0 @md:flex-row @md:items-start @md:justify-between @md:gap-4">
      <div className="min-w-0 space-y-1">
        <Label htmlFor={id}>{label}</Label>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <div className="flex shrink-0 items-center pointer-coarse:min-h-10">{children}</div>
    </div>
  )
}
