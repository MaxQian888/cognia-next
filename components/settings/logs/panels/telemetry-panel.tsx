"use client"

/**
 * Logs → Telemetry & analytics.
 *
 * Behaviour telemetry and PostHog were two different tabs, which hid the one
 * thing a user needs to know about them: PostHog product analytics only emits
 * while behaviour telemetry is on, so a user could enable a destination, save,
 * and see nothing. They are one consent story and now read as one — the master
 * opt-in first, the destinations it feeds underneath it, disabled and labelled
 * when the gate above is closed.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { ActivitySquareIcon, ShieldIcon } from "lucide-react"

import {
  SettingsBlock,
  SettingsField,
  SettingsStack,
} from "@/components/settings/common/settings-block"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ClampedNumberInput } from "@/components/settings/common/clamped-number-input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { clearBehaviorEvents, exportBehaviorEvents } from "@/lib/db/behavior-events"
import { BEHAVIOR_TELEMETRY_CATEGORIES } from "@/lib/telemetry/events/settings"
import { trackEventDelivery } from "@/lib/telemetry/events/track-event"
import { isValidPostHogProject } from "@/lib/telemetry/posthog-product"

import { SliderField } from "../components/slider-field"
import type { UseLogSettingsDraftResult } from "@/hooks/logging/use-log-settings-draft"

export interface LogsTelemetryPanelProps {
  draft: UseLogSettingsDraftResult
}

interface ScopeControlsProps {
  title: string
  description: string
  disabled: boolean
  disabledReason?: string
  productChecked: boolean
  aiChecked: boolean
  productTestId: string
  aiTestId: string
  onProductChange: (checked: boolean) => void
  onAiChange: (checked: boolean) => void
}

function PostHogScopeControls({
  title,
  description,
  disabled,
  disabledReason,
  productChecked,
  aiChecked,
  productTestId,
  aiTestId,
  onProductChange,
  onAiChange,
}: ScopeControlsProps) {
  const t = useTranslations("logging.settings.posthog")

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <h4 className="text-sm font-medium">{title}</h4>
        {disabled && disabledReason ? (
          <Badge variant="outline" className="text-[10px]">
            {disabledReason}
          </Badge>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">{description}</p>
      <div className="grid gap-3 @md/settings-stack:grid-cols-2">
        <div className="flex items-start justify-between gap-3 rounded-lg border p-3">
          <div className="min-w-0 space-y-0.5">
            <Label htmlFor={productTestId} className="text-sm font-medium">
              {t("productAnalytics")}
            </Label>
            <p className="text-xs text-muted-foreground">{t("productAnalyticsDesc")}</p>
          </div>
          <Switch
            id={productTestId}
            data-testid={productTestId}
            checked={productChecked}
            disabled={disabled}
            onCheckedChange={onProductChange}
          />
        </div>
        <div className="flex items-start justify-between gap-3 rounded-lg border p-3">
          <div className="min-w-0 space-y-0.5">
            <Label htmlFor={aiTestId} className="text-sm font-medium">
              {t("aiObservability")}
            </Label>
            <p className="text-xs text-muted-foreground">{t("aiObservabilityDesc")}</p>
          </div>
          <Switch
            id={aiTestId}
            data-testid={aiTestId}
            checked={aiChecked}
            disabled={disabled}
            onCheckedChange={onAiChange}
          />
        </div>
      </div>
    </div>
  )
}

export function LogsTelemetryPanel({ draft }: LogsTelemetryPanelProps) {
  const t = useTranslations("logging")
  const [testStatus, setTestStatus] = useState<"idle" | "sent" | "blocked">("idle")

  const behavior = draft.behaviorTelemetry
  const posthog = draft.transports.posthogConfig

  const managedAvailable = isValidPostHogProject(
    process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "",
    process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN ?? ""
  )
  const byoAvailable = isValidPostHogProject(posthog.byo.host, posthog.byo.projectToken)
  const productDestinationIds = [
    ...(managedAvailable && posthog.managed.productAnalytics ? ["posthog-managed"] : []),
    ...(byoAvailable && posthog.byo.productAnalytics ? ["posthog-byo"] : []),
  ]
  const hasProductDestination = productDestinationIds.length > 0

  const exportEvents = async (format: "json" | "csv") => {
    const contents = await exportBehaviorEvents(format)
    const url = URL.createObjectURL(
      new Blob([contents], { type: format === "json" ? "application/json" : "text/csv" })
    )
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = `cognia-behavior-events-${new Date().toISOString()}.${format}`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  return (
    <SettingsStack>
      <Alert data-testid="logs-telemetry-privacy">
        <ShieldIcon className="size-4" />
        <AlertTitle>{t("settings.posthog.privacyTitle")}</AlertTitle>
        <AlertDescription>{t("settings.posthog.privacyDescription")}</AlertDescription>
      </Alert>

      <SettingsBlock
        icon={<ActivitySquareIcon />}
        title={t("settings.behaviorTelemetry.title")}
        description={t("settings.behaviorTelemetry.disclosure")}
        testid="logs-telemetry-behavior"
        badge={
          <Badge variant={behavior.enabled ? "secondary" : "outline"} className="text-[10px]">
            {t(
              behavior.enabled ? "settings.behaviorTelemetry.on" : "settings.behaviorTelemetry.off"
            )}
          </Badge>
        }
      >
        <SettingsField
          htmlFor="behavior-telemetry-switch"
          label={t("settings.behaviorTelemetry.optIn")}
          description={t("settings.behaviorTelemetry.optInDesc")}
        >
          <Switch
            id="behavior-telemetry-switch"
            data-testid="behavior-telemetry-switch"
            checked={behavior.enabled}
            onCheckedChange={(enabled) =>
              draft.setBehaviorTelemetry((previous) => ({ ...previous, enabled }))
            }
          />
        </SettingsField>

        <div className="space-y-3">
          <div>
            <p className="text-sm font-medium">
              {t("settings.behaviorTelemetry.destinations.title")}
            </p>
            <p className="text-xs text-muted-foreground">
              {t("settings.behaviorTelemetry.destinations.description")}
            </p>
          </div>
          {(["local", "remote"] as const).map((destination) => (
            <SettingsField
              key={destination}
              htmlFor={`behavior-telemetry-${destination}-switch`}
              label={t(`settings.behaviorTelemetry.destinations.${destination}.label`)}
              description={t(`settings.behaviorTelemetry.destinations.${destination}.description`)}
              disabled={!behavior.enabled}
            >
              <Switch
                id={`behavior-telemetry-${destination}-switch`}
                data-testid={`behavior-telemetry-${destination}-switch`}
                checked={behavior.destinations[destination]}
                disabled={!behavior.enabled}
                onCheckedChange={(checked) =>
                  draft.setBehaviorTelemetry((previous) => ({
                    ...previous,
                    destinations: { ...previous.destinations, [destination]: checked },
                  }))
                }
              />
            </SettingsField>
          ))}
        </div>

        <div className="space-y-3">
          <div>
            <p className="text-sm font-medium">
              {t("settings.behaviorTelemetry.categories.title")}
            </p>
            <p className="text-xs text-muted-foreground">
              {t("settings.behaviorTelemetry.categories.description")}
            </p>
          </div>
          <div className="grid gap-2 @md/settings-stack:grid-cols-2">
            {BEHAVIOR_TELEMETRY_CATEGORIES.map((category) => (
              <div
                key={category}
                className="flex items-center justify-between gap-3 rounded-lg border p-2.5"
              >
                <Label
                  htmlFor={`behavior-telemetry-category-${category}`}
                  className="min-w-0 text-sm"
                >
                  {t(`settings.behaviorTelemetry.categories.${category}`)}
                </Label>
                <Switch
                  id={`behavior-telemetry-category-${category}`}
                  data-testid={`behavior-telemetry-category-${category}`}
                  checked={behavior.categories[category]}
                  disabled={!behavior.enabled}
                  onCheckedChange={(checked) =>
                    draft.setBehaviorTelemetry((previous) => ({
                      ...previous,
                      categories: { ...previous.categories, [category]: checked },
                    }))
                  }
                />
              </div>
            ))}
          </div>
        </div>

        <div className="grid gap-4 @md/settings-stack:grid-cols-2">
          <SliderField
            id="behavior-telemetry-sample-rate"
            label={t("settings.behaviorTelemetry.sampleRate")}
            valueLabel={`${Math.round(behavior.sampleRate * 100)}%`}
            value={Math.round(behavior.sampleRate * 100)}
            min={0}
            max={100}
            step={5}
            disabled={!behavior.enabled}
            onValueChange={(value) =>
              draft.setBehaviorTelemetry((previous) => ({ ...previous, sampleRate: value / 100 }))
            }
            testid="behavior-telemetry-sample-rate"
            className="border-b-0 pb-0"
          />
          <SliderField
            id="behavior-telemetry-retention-days"
            label={t("settings.behaviorTelemetry.retentionDays")}
            valueLabel={String(behavior.retentionDays)}
            value={behavior.retentionDays}
            min={1}
            max={365}
            disabled={!behavior.enabled || !behavior.destinations.local}
            onValueChange={(value) =>
              draft.setBehaviorTelemetry((previous) => ({ ...previous, retentionDays: value }))
            }
            testid="behavior-telemetry-retention-days"
            className="border-b-0 pb-0"
          />
          <div className="space-y-1.5">
            <Label htmlFor="behavior-telemetry-max-events" className="text-sm font-medium">
              {t("settings.behaviorTelemetry.maxStoredEvents")}
            </Label>
            {/* Clamping on every keystroke made this field unusable: the
                floor is three digits, so typing "5000" clamped "5" up to 100
                and the remaining digits appended to that. `ClampedNumberInput`
                keeps a local draft and clamps on commit. */}
            <ClampedNumberInput
              id="behavior-telemetry-max-events"
              value={behavior.maxStoredEvents}
              min={100}
              max={100000}
              integer
              disabled={!behavior.enabled || !behavior.destinations.local}
              onCommit={(maxStoredEvents) =>
                draft.setBehaviorTelemetry((previous) => ({ ...previous, maxStoredEvents }))
              }
            />
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void exportEvents("json")}
          >
            {t("settings.behaviorTelemetry.exportJson")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void exportEvents("csv")}
          >
            {t("settings.behaviorTelemetry.exportCsv")}
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={() => void clearBehaviorEvents()}
          >
            {t("settings.behaviorTelemetry.clear")}
          </Button>
        </div>
      </SettingsBlock>

      <SettingsBlock
        title={t("settings.posthog.title")}
        description={t("settings.posthog.description")}
        testid="logs-telemetry-posthog"
      >
        <PostHogScopeControls
          title={t("settings.posthog.managed.title")}
          description={
            managedAvailable
              ? t("settings.posthog.managed.available")
              : t("settings.posthog.managed.unavailable")
          }
          disabled={!managedAvailable}
          disabledReason={t("settings.posthog.unavailableBadge")}
          productChecked={posthog.managed.productAnalytics}
          aiChecked={posthog.managed.aiObservability}
          productTestId="posthog-managed-product-switch"
          aiTestId="posthog-managed-ai-switch"
          onProductChange={(checked) => {
            draft.setPostHog("managed", "productAnalytics", checked)
            setTestStatus("idle")
          }}
          onAiChange={(checked) => {
            draft.setPostHog("managed", "aiObservability", checked)
            setTestStatus("idle")
          }}
        />

        <div className="space-y-4 border-t border-border/60 pt-4">
          <div>
            <h4 className="text-sm font-medium">{t("settings.posthog.byo.title")}</h4>
            <p className="text-xs text-muted-foreground">{t("settings.posthog.byo.description")}</p>
          </div>
          <div className="grid gap-4 @md/settings-stack:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="posthog-byo-host" className="text-xs">
                {t("settings.posthog.byo.host")}
              </Label>
              <Input
                id="posthog-byo-host"
                value={posthog.byo.host}
                // i18n-exempt: canonical PostHog ingestion origin
                placeholder="https://us.i.posthog.com"
                onChange={(event) => {
                  draft.setPostHog("byo", "host", event.target.value)
                  setTestStatus("idle")
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="posthog-byo-token" className="text-xs">
                {t("settings.posthog.byo.token")}
              </Label>
              <Input
                id="posthog-byo-token"
                type="password"
                autoComplete="off"
                value={posthog.byo.projectToken}
                placeholder={t("settings.posthog.byo.tokenPlaceholder")}
                onChange={(event) => {
                  draft.setPostHog("byo", "projectToken", event.target.value)
                  setTestStatus("idle")
                }}
              />
              <p className="text-xs text-muted-foreground">{t("settings.posthog.byo.tokenHint")}</p>
            </div>
          </div>
          <PostHogScopeControls
            title={t("settings.posthog.byo.scopes")}
            description={t("settings.posthog.byo.scopesDescription")}
            disabled={!byoAvailable}
            disabledReason={t("settings.posthog.incompleteBadge")}
            productChecked={posthog.byo.productAnalytics}
            aiChecked={posthog.byo.aiObservability}
            productTestId="posthog-byo-product-switch"
            aiTestId="posthog-byo-ai-switch"
            onProductChange={(checked) => {
              draft.setPostHog("byo", "productAnalytics", checked)
              setTestStatus("idle")
            }}
            onAiChange={(checked) => {
              draft.setPostHog("byo", "aiObservability", checked)
              setTestStatus("idle")
            }}
          />
        </div>

        <div className="flex flex-wrap items-center gap-3 border-t border-border/60 pt-4">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={async () => {
              // A test that "succeeds" against unsaved edits would prove
              // nothing: the runtime destinations are whatever was last saved.
              if (draft.status === "dirty" || !hasProductDestination) {
                setTestStatus("blocked")
                return
              }
              const delivery = await trackEventDelivery("telemetry.posthog.test", {
                source: "settings",
              })
              const everyPostHogDestinationAccepted = productDestinationIds.every((id) =>
                delivery.delivered.includes(id)
              )
              setTestStatus(everyPostHogDestinationAccepted ? "sent" : "blocked")
            }}
          >
            {t("settings.posthog.sendTest")}
          </Button>
          {testStatus !== "idle" ? (
            <span className="text-xs text-muted-foreground" role="status">
              {t(`settings.posthog.testStatus.${testStatus}`)}
            </span>
          ) : null}
        </div>
      </SettingsBlock>
    </SettingsStack>
  )
}
