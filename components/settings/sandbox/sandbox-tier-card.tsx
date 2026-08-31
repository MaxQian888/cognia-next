// ADR-0028 / T4 — default tier picker.
//
// `AppSettings.sandboxTier` is the global default. Beaten by
// `Character.sandboxTier` when the user opens a session bound to a
// character that overrides it. Only consulted when sandbox is enabled.

"use client"

import { useId } from "react"
import { useTranslations } from "next-intl"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { saveSettings } from "@/lib/db/settings"
import { useSettingsStore } from "@/stores/settings"
import { useSandboxRuntimeAvailability } from "@/hooks/sandbox/use-sandbox-runtime-availability"

const TIER_VALUES = ["os", "microvm"] as const
type Tier = (typeof TIER_VALUES)[number]

function isTier(value: string): value is Tier {
  return (TIER_VALUES as readonly string[]).includes(value)
}

export function SandboxTierCard() {
  const t = useTranslations("settings.sandbox.tier")
  const settings = useSettingsStore((s) => s.settings)
  const availability = useSandboxRuntimeAvailability()
  const groupId = useId()
  const current: Tier = settings?.sandboxTier ?? "os"

  return (
    <Card>
      <CardHeader>
        <CardTitle id={groupId}>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <RadioGroup
          value={current}
          onValueChange={(value) => {
            if (isTier(value)) {
              void saveSettings({ sandboxTier: value })
            }
          }}
          aria-labelledby={groupId}
          data-testid="sandbox-tier-picker"
        >
          {TIER_VALUES.map((tier) => {
            const id = `${groupId}-${tier}`
            const runtime = availability[tier]
            const reason =
              tier === "microvm"
                ? runtime.available
                  ? t("availability.workspaceRequired")
                  : t("availability.adapterMissing")
                : runtime.available
                  ? undefined
                  : availability.os.reason === "probe-failed"
                    ? t("availability.probeFailed")
                    : t("availability.probeRequired")
            return (
              <div key={tier} className="flex items-start gap-3 py-2">
                <RadioGroupItem
                  id={id}
                  value={tier}
                  disabled={!runtime.available}
                  data-testid={`tier-${tier}`}
                />
                <div className="grid gap-1">
                  <Label htmlFor={id} className="text-sm font-medium">
                    {t(`${tier}.label`)}
                  </Label>
                  <p className="text-xs text-muted-foreground">{t(`${tier}.description`)}</p>
                  {reason ? <p className="text-xs text-amber-600">{reason}</p> : null}
                </div>
              </div>
            )
          })}
        </RadioGroup>
      </CardContent>
    </Card>
  )
}
