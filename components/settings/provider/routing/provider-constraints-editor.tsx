"use client"

// Per-provider constraint rows: daily budget (USD, advisory), RPM/TPM
// ceilings, enabled flag. Persists through `setRoutingConfig`.

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { Plus, Trash2 } from "lucide-react"

import { useSettingsStore } from "@/stores/settings"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { collectOptions, groupByProvider } from "@cognia/provider-routing/model-option-source"
import {
  DEFAULT_ROUTING_CONFIG,
  type ProviderConstraint,
} from "@cognia/provider-types/model-mapping"

function numOrUndefined(raw: string): number | undefined {
  if (raw.trim() === "") return undefined
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

export function ProviderConstraintsEditor() {
  const t = useTranslations("providers.routingView")
  const routingConfig = useSettingsStore((s) => s.settings?.routingConfig) ?? DEFAULT_ROUTING_CONFIG
  const providerSettings = useSettingsStore((s) => s.settings?.providerSettings)
  const customProviders = useSettingsStore((s) => s.settings?.customProviders)
  const setRoutingConfig = useSettingsStore((s) => s.setRoutingConfig)

  const providerIds = useMemo(
    () =>
      groupByProvider(collectOptions(providerSettings, customProviders)).map((g) => g.providerId),
    [providerSettings, customProviders]
  )

  const constraints = routingConfig.providerConstraints

  const update = (index: number, patch: Partial<ProviderConstraint>) => {
    const next = constraints.map((c, i) => (i === index ? { ...c, ...patch } : c))
    void setRoutingConfig({ providerConstraints: next })
  }

  const remove = (index: number) => {
    void setRoutingConfig({ providerConstraints: constraints.filter((_, i) => i !== index) })
  }

  const add = () => {
    const used = new Set(constraints.map((c) => c.providerId))
    const firstFree = providerIds.find((id) => !used.has(id)) ?? providerIds[0] ?? "anthropic"
    void setRoutingConfig({
      providerConstraints: [...constraints, { providerId: firstFree, enabled: true }],
    })
  }

  return (
    <div className="space-y-3">
      {constraints.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("noConstraints")}</p>
      ) : (
        <div className="space-y-2">
          {constraints.map((c, i) => (
            <div
              key={`${c.providerId}-${i}`}
              className="flex flex-wrap items-end gap-2 rounded-lg border px-3 py-2.5"
              data-testid={`constraint-row-${i}`}
            >
              <div className="min-w-32 space-y-1">
                <p className="text-[10px] text-muted-foreground">{t("constraintProvider")}</p>
                <Select value={c.providerId} onValueChange={(v) => update(i, { providerId: v })}>
                  <SelectTrigger className="h-8 w-36 text-xs" aria-label={t("constraintProvider")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[...new Set([c.providerId, ...providerIds])].map((id) => (
                      <SelectItem key={id} value={id}>
                        {id}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="w-24 space-y-1">
                <p className="text-[10px] text-muted-foreground">{t("dailyCostBudget")}</p>
                <Input
                  type="number"
                  min={0}
                  step="0.5"
                  value={c.dailyCostBudget ?? ""}
                  aria-label={t("dailyCostBudget")}
                  onChange={(e) => update(i, { dailyCostBudget: numOrUndefined(e.target.value) })}
                  className="h-8 text-xs"
                />
              </div>
              <div className="w-24 space-y-1">
                <p className="text-[10px] text-muted-foreground">{t("maxRpm")}</p>
                <Input
                  type="number"
                  min={0}
                  value={c.maxRequestsPerMinute ?? ""}
                  aria-label={t("maxRpm")}
                  onChange={(e) =>
                    update(i, { maxRequestsPerMinute: numOrUndefined(e.target.value) })
                  }
                  className="h-8 text-xs"
                />
              </div>
              <div className="w-28 space-y-1">
                <p className="text-[10px] text-muted-foreground">{t("maxTpm")}</p>
                <Input
                  type="number"
                  min={0}
                  value={c.maxTokensPerMinute ?? ""}
                  aria-label={t("maxTpm")}
                  onChange={(e) =>
                    update(i, { maxTokensPerMinute: numOrUndefined(e.target.value) })
                  }
                  className="h-8 text-xs"
                />
              </div>
              <div className="ml-auto flex items-center gap-2 pb-1">
                <Switch
                  checked={c.enabled}
                  aria-label={t("constraintEnabled")}
                  onCheckedChange={(enabled) => update(i, { enabled })}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-destructive"
                  aria-label={t("removeConstraint")}
                  onClick={() => remove(i)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Button variant="outline" size="sm" className="h-7 text-xs" onClick={add}>
        <Plus className="mr-1 h-3 w-3" />
        {t("addConstraint")}
      </Button>
    </div>
  )
}

export default ProviderConstraintsEditor
