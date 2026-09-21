"use client"

// Router + Fusion settings (ADR-0188 D36–D38). Everything here is opt-in: the
// master switch and every surface default off, and with them off routing
// behaves exactly as it did before. Surfaces, Auto rule rows and actions this
// build does not wire are shown disabled and labelled "later release" (Rule 7)
// — their switches exist so settings round-trip, and they have no effect.

import { useMemo, useSyncExternalStore } from "react"
import { useFormatter, useTranslations } from "next-intl"
import { toast } from "sonner"
import { AlertTriangle, RotateCcw } from "lucide-react"

import { SettingsAlert } from "@/components/settings/common/settings-section"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { collectOptions, groupByProvider } from "@cognia/provider-routing/model-option-source"
import { RULE_ROWS, type RuleRowId } from "@cognia/router-fusion/routing/action-router"
import {
  normalizeRouterFusionSettings,
  WIRED_RULE_ROWS,
  type RouterFusionSettings,
} from "@cognia/router-fusion/settings/settings"
import {
  isRouterFusionSurfaceWired,
  ROUTER_FUSION_SURFACES,
  type RouterFusionSurface,
} from "@cognia/router-fusion/settings/switches"
import { getBreakerSnapshot, subscribeBreaker } from "@/lib/router-fusion/gate/breaker"
import { rearmRouterFusionSurface } from "@/lib/router-fusion/gate/breaker-persistence"
import {
  enableRouterFusion,
  restoreLegacyAuto,
  showsLegacyAutoNotice,
} from "@/lib/router-fusion/settings/legacy-auto-migration"
import { saveRouterFusionSettings } from "@/lib/router-fusion/settings/save-router-fusion-settings"
import { useSettingsStore } from "@/stores/settings"
import { DelegateAcceptanceProfiles } from "@/components/router-fusion/delegate-acceptance-profiles"

import { RouterFusionActionCatalog } from "./router-fusion-action-catalog"
import { RouterFusionClassifierSection } from "./router-fusion-classifier-section"
import { RouterFusionUsdField as UsdField } from "./router-fusion-usd-field"

const DATA_CLASSES = ["public", "internal", "restricted"] as const
/**
 * The modes whose run cap this section edits with a `routerFusion` label.
 * `delegate` is capped too (B4 brought it out of dormancy) and gets its own
 * field below, from the delegate namespace.
 */
const CAPPED_MODES = ["direct", "cascade", "panel"] as const

/** The in-memory trip of a surface, re-read whenever the breaker publishes. */
function useLiveTrip(surface: RouterFusionSurface): number | null {
  return useSyncExternalStore(
    (onChange) => subscribeBreaker(() => onChange()),
    () => getBreakerSnapshot(surface).trip?.trippedAt ?? null,
    () => null
  )
}

export function RouterFusionSection() {
  const t = useTranslations("routerFusion.settings")
  const tDelegate = useTranslations("routerFusionDelegate.settings")
  const format = useFormatter()
  const raw = useSettingsStore((s) => s.settings?.routerFusion)
  const autoRouting = useSettingsStore((s) => s.settings?.autoRouting)
  const providerSettings = useSettingsStore((s) => s.settings?.providerSettings)
  const customProviders = useSettingsStore((s) => s.settings?.customProviders)
  const modelMappings = useSettingsStore((s) => s.settings?.modelMappings)
  const settings = useMemo(() => normalizeRouterFusionSettings(raw), [raw])
  const liveChatTrip = useLiveTrip("chat")

  const providerIds = useMemo(
    () =>
      groupByProvider(collectOptions(providerSettings, customProviders)).map(
        (group) => group.providerId
      ),
    [providerSettings, customProviders]
  )

  const aliases = useMemo(
    () =>
      (modelMappings ?? []).filter((mapping) => mapping.enabled).map((mapping) => mapping.alias),
    [modelMappings]
  )

  const persist = (
    patch:
      | Partial<RouterFusionSettings>
      | ((current: RouterFusionSettings) => Partial<RouterFusionSettings>)
  ) =>
    void saveRouterFusionSettings(patch).catch((error) => {
      console.error("[router-fusion] settings save failed", error)
      toast.error(t("saveFailed"))
    })

  const setMaster = (on: boolean) =>
    persist((current) =>
      on ? enableRouterFusion(current, autoRouting, Date.now()) : { enabled: false }
    )

  const restore = () => {
    const restored = restoreLegacyAuto(settings)
    void useSettingsStore
      .getState()
      .save({
        routerFusion: restored.routerFusion,
        ...(restored.autoRouting ? { autoRouting: restored.autoRouting } : {}),
      })
      .then(() => toast.success(t("migration.restored")))
      .catch((error) => {
        console.error("[router-fusion] legacy Auto restore failed", error)
        toast.error(t("saveFailed"))
      })
  }

  const rearm = (surface: RouterFusionSurface) =>
    void rearmRouterFusionSurface(surface, {
      readTrips: () =>
        normalizeRouterFusionSettings(useSettingsStore.getState().settings?.routerFusion)
          .trippedSurfaces,
      writeTrips: (trips) =>
        saveRouterFusionSettings({ trippedSurfaces: trips }).then(() => undefined),
    })
      .then(() =>
        toast.success(t("breaker.rearmed", { surface: t(`surface.${surface}.label` as never) }))
      )
      .catch((error) => {
        console.error("[router-fusion] re-arm failed", error)
        toast.error(t("saveFailed"))
      })

  const chatTrip =
    settings.trippedSurfaces.chat ??
    (liveChatTrip !== null ? getBreakerSnapshot("chat").trip : null)

  return (
    <div className="space-y-5" data-testid="router-fusion-section">
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-0.5">
          <Label className="text-xs" htmlFor="router-fusion-master">
            {t("master")}
          </Label>
          <p className="text-[11px] text-muted-foreground">{t("masterDesc")}</p>
        </div>
        <Switch
          id="router-fusion-master"
          checked={settings.enabled}
          onCheckedChange={setMaster}
          aria-label={t("master")}
        />
      </div>

      {showsLegacyAutoNotice(settings) ? (
        <SettingsAlert
          action={
            <div className="flex flex-col gap-1.5">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={() => persist({ migrationNoticeDismissed: true })}
              >
                {t("migration.dismiss")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 gap-1 text-xs"
                title={t("migration.restoreDesc")}
                onClick={restore}
              >
                <RotateCcw className="size-3" aria-hidden />
                {t("migration.restore")}
              </Button>
            </div>
          }
        >
          <p className="text-xs" data-testid="router-fusion-migration-notice">
            {t("migration.notice")}
          </p>
        </SettingsAlert>
      ) : null}

      <section className="space-y-2" aria-labelledby="router-fusion-surfaces">
        <div>
          <h4 id="router-fusion-surfaces" className="text-xs font-medium">
            {t("surfacesTitle")}
          </h4>
          <p className="text-[11px] text-muted-foreground">
            {settings.enabled ? t("surfacesDesc") : t("surfaceNeedsMaster")}
          </p>
        </div>
        <ul className="space-y-1.5">
          {ROUTER_FUSION_SURFACES.map((surface) => {
            const wired = isRouterFusionSurfaceWired(surface)
            const label = t(`surface.${surface}.label` as never)
            const trip = surface === "chat" ? chatTrip : settings.trippedSurfaces[surface]
            return (
              <li
                key={surface}
                className="space-y-2 rounded-lg border px-3 py-2"
                data-testid={`router-fusion-surface-${surface}`}
                data-dormant={wired ? undefined : "true"}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Label
                        className="text-xs"
                        htmlFor={`router-fusion-surface-${surface}-switch`}
                      >
                        {label}
                      </Label>
                      {wired ? null : (
                        <Badge variant="secondary" className="h-4 px-1 text-[10px] font-normal">
                          {t("laterRelease")}
                        </Badge>
                      )}
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      {wired ? t(`surface.${surface}.desc` as never) : t("laterReleaseDesc")}
                    </p>
                  </div>
                  <Switch
                    id={`router-fusion-surface-${surface}-switch`}
                    checked={wired && settings.surfaces[surface]}
                    disabled={!wired || !settings.enabled}
                    onCheckedChange={(on) =>
                      persist((current) => ({ surfaces: { ...current.surfaces, [surface]: on } }))
                    }
                    aria-label={label}
                  />
                </div>
                {wired && trip ? (
                  <div
                    className="flex items-start justify-between gap-2 rounded-md bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-700 dark:text-amber-400"
                    data-testid={`router-fusion-trip-${surface}`}
                  >
                    <span className="flex items-start gap-1.5">
                      <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
                      {t("breaker.tripped", {
                        reason: trip.reason,
                        when: format.dateTime(new Date(trip.trippedAt), {
                          dateStyle: "medium",
                          timeStyle: "short",
                        }),
                      })}
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-6 shrink-0 text-[11px]"
                      onClick={() => rearm(surface)}
                    >
                      {t("breaker.rearm")}
                    </Button>
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
      </section>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-xs">{t("budget.mode")}</Label>
          <Select
            value={settings.budgetMode}
            onValueChange={(value) =>
              persist({ budgetMode: value === "strict" ? "strict" : "tracked" })
            }
          >
            <SelectTrigger className="h-8 w-full max-w-60 text-xs" aria-label={t("budget.mode")}>
              {/* The label only: the option's description is repeated below. */}
              <SelectValue>{t(`budget.${settings.budgetMode}`)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {(["tracked", "strict"] as const).map((mode) => (
                <SelectItem key={mode} value={mode} textValue={t(`budget.${mode}`)}>
                  <div className="flex flex-col items-start">
                    <span className="text-xs font-medium">{t(`budget.${mode}`)}</span>
                    <span className="text-[10px] text-muted-foreground">
                      {t(`budget.${mode}Desc`)}
                    </span>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[11px] text-muted-foreground">
            {t(`budget.${settings.budgetMode}Desc`)}
          </p>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs" htmlFor="router-fusion-threshold">
            {t("breaker.threshold")}
          </Label>
          <Input
            id="router-fusion-threshold"
            type="number"
            min={1}
            max={100}
            value={settings.breakerThreshold}
            onChange={(event) => {
              const next = Number(event.target.value)
              if (Number.isSafeInteger(next) && next >= 1 && next <= 100)
                persist({ breakerThreshold: next })
            }}
            className="h-8 w-24 text-xs"
          />
          <p className="text-[11px] text-muted-foreground">{t("breaker.thresholdDesc")}</p>
        </div>

        {CAPPED_MODES.map((mode) => (
          <UsdField
            key={mode}
            id={`router-fusion-${mode}-cap`}
            label={t(`budget.${mode}Cap`)}
            description={t(`budget.${mode}CapDesc`)}
            value={settings.runCapUsdByMode[mode]}
            onCommit={(value) =>
              persist((current) => ({
                runCapUsdByMode: { ...current.runCapUsdByMode, [mode]: value },
              }))
            }
          />
        ))}

        <UsdField
          id="router-fusion-delegate-cap"
          label={tDelegate("runCap")}
          description={tDelegate("runCapDesc")}
          value={settings.runCapUsdByMode.delegate}
          onCommit={(value) =>
            persist((current) => ({
              runCapUsdByMode: { ...current.runCapUsdByMode, delegate: value },
            }))
          }
        />

        <UsdField
          id="router-fusion-unknown-reserve"
          label={t("budget.unknownReserve")}
          description={t("budget.unknownReserveDesc")}
          value={settings.unknownPriceCallReserveUsd}
          onCommit={(value) => persist({ unknownPriceCallReserveUsd: value })}
        />
      </div>

      <section className="space-y-2" aria-labelledby="router-fusion-data-class">
        <div className="space-y-1.5">
          <Label id="router-fusion-data-class" className="text-xs">
            {t("dataClass.label")}
          </Label>
          <Select
            value={settings.defaultDataClass}
            onValueChange={(value) =>
              persist({
                defaultDataClass: (DATA_CLASSES as readonly string[]).includes(value)
                  ? (value as (typeof DATA_CLASSES)[number])
                  : "internal",
              })
            }
          >
            <SelectTrigger className="h-8 w-40 text-xs" aria-label={t("dataClass.label")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DATA_CLASSES.map((dataClass) => (
                <SelectItem key={dataClass} value={dataClass}>
                  {t(`dataClass.${dataClass}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[11px] text-muted-foreground">{t("dataClass.desc")}</p>
        </div>
        <div className="space-y-1.5">
          <p className="text-xs">{t("dataClass.grants")}</p>
          <p className="text-[11px] text-muted-foreground">{t("dataClass.grantsDesc")}</p>
          {providerIds.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">{t("dataClass.noProviders")}</p>
          ) : (
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {providerIds.map((providerId) => {
                const id = `router-fusion-grant-${providerId}`
                return (
                  <div key={providerId} className="flex items-center gap-1.5">
                    <Checkbox
                      id={id}
                      checked={settings.restrictedGrantProviderIds.includes(providerId)}
                      onCheckedChange={(checked) =>
                        persist((current) => ({
                          restrictedGrantProviderIds:
                            checked === true
                              ? [...current.restrictedGrantProviderIds, providerId]
                              : current.restrictedGrantProviderIds.filter(
                                  (grant) => grant !== providerId
                                ),
                        }))
                      }
                    />
                    <Label htmlFor={id} className="text-xs font-normal">
                      {providerId}
                    </Label>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </section>

      <section className="space-y-2" aria-labelledby="router-fusion-rules">
        <div>
          <h4 id="router-fusion-rules" className="text-xs font-medium">
            {t("rules.title")}
          </h4>
          <p className="text-[11px] text-muted-foreground">{t("rules.desc")}</p>
        </div>
        <ul className="space-y-1.5">
          {RULE_ROWS.map((row: RuleRowId) => {
            const wired = WIRED_RULE_ROWS.includes(row)
            const approved = wired && settings.approvedRuleRows.includes(row)
            const provenance = settings.ruleRowProvenance[row]
            const label = t(`rules.row.${row}.label` as never)
            return (
              <li
                key={row}
                className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2"
                data-testid={`router-fusion-rule-${row}`}
                data-dormant={wired ? undefined : "true"}
              >
                <div className="min-w-0 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Label className="text-xs" htmlFor={`router-fusion-rule-${row}-switch`}>
                      {label}
                    </Label>
                    {wired ? null : (
                      <Badge variant="secondary" className="h-4 px-1 text-[10px] font-normal">
                        {t("laterRelease")}
                      </Badge>
                    )}
                    {approved ? (
                      <Badge variant="outline" className="h-4 px-1 text-[10px] font-normal">
                        {provenance === "migrated_legacy_auto"
                          ? t("rules.provenanceMigrated")
                          : t("rules.provenanceUser")}
                      </Badge>
                    ) : null}
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    {wired ? t(`rules.row.${row}.desc` as never) : t("laterReleaseDesc")}
                  </p>
                </div>
                <Switch
                  id={`router-fusion-rule-${row}-switch`}
                  checked={approved}
                  disabled={!wired}
                  onCheckedChange={(on) =>
                    persist((current) => {
                      const rows = current.approvedRuleRows.filter((id) => id !== row)
                      const provenanceByRow = { ...current.ruleRowProvenance }
                      delete provenanceByRow[row]
                      return on
                        ? {
                            approvedRuleRows: [...rows, row],
                            ruleRowProvenance: { ...provenanceByRow, [row]: "user" },
                          }
                        : { approvedRuleRows: rows, ruleRowProvenance: provenanceByRow }
                    })
                  }
                  aria-label={label}
                />
              </li>
            )
          })}
        </ul>
      </section>

      <RouterFusionClassifierSection settings={settings} persist={persist} />

      <DelegateAcceptanceProfiles enabled={settings.enabled} />

      <RouterFusionActionCatalog settings={settings} aliases={aliases} persist={persist} />
    </div>
  )
}

export default RouterFusionSection
