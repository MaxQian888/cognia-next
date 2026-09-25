"use client"

// Settings card for System-1 decisions (ADR-0194): which provider answers
// typed questions (the IM reply copilot's judge + rank, plugin `ctx.decisions`),
// and the built-in remote endpoint's preset / URL / model / key. Reads and
// writes `AppSettings.decisions`; the endpoint key goes to the keyring through
// `lib/decisions/config.ts`, never into settings.

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Spinner } from "@/components/ui/spinner"
import { useDecisionProvider, useDecisionProviders } from "@/hooks/decisions/use-decision-providers"
import { hasDecisionHttpKey, setDecisionHttpKey } from "@/lib/decisions/config"
import { DECISION_HTTP_PRESETS, resolveDecisionEndpoint } from "@/lib/decisions/presets"
import { BUILTIN_HTTP_PROVIDER_ID } from "@/lib/decisions/providers/decisions-http"
import { runDecision } from "@/lib/decisions/run-decision"
import { resolvePluginLabel } from "@/lib/plugin/i18n/plugin-label"
import { useSettingsStore } from "@/stores/settings/settings-store"
import {
  DECISION_HTTP_PRESET_IDS,
  type DecisionErrorKind,
  type DecisionHttpPresetId,
  type DecisionProvider,
  type DecisionProviderStatus,
  type DecisionSettings,
} from "@/types/decisions"

/** One-question probe: cheap, PII-free, answerable by every provider. */
export const DECISION_PROBE_REQUEST = {
  state: { post: "Good morning, everyone!" },
  questions: {
    greeting: { type: "noul" as const, instructions: "Is `post` a greeting?" },
  },
}

type TestState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "ok"; latencyMs: number }
  | { kind: "failed"; errorKind: DecisionErrorKind }

type StatusState = { kind: "checking" } | { kind: "known"; status: DecisionProviderStatus }

function useProviderStatus(
  provider: DecisionProvider | undefined,
  revision: number
): StatusState | null {
  const [state, setState] = useState<StatusState | null>(null)
  useEffect(() => {
    if (!provider?.status) return
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled) setState({ kind: "checking" })
    })
    Promise.resolve()
      .then(() => provider.status?.())
      .then(
        (status) => {
          if (!cancelled && status) setState({ kind: "known", status })
        },
        (error: unknown) => {
          if (!cancelled) {
            setState({
              kind: "known",
              status: {
                ready: false,
                message: error instanceof Error ? error.message : String(error),
              },
            })
          }
        }
      )
    return () => {
      cancelled = true
    }
  }, [provider, revision])
  return provider?.status ? state : null
}

export function DecisionProviderCard() {
  const t = useTranslations("settings.decisionProviders")
  const tRoot = useTranslations()
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)
  const decisions: DecisionSettings = settings?.decisions ?? {}
  const providers = useDecisionProviders()
  const selected = useDecisionProvider(decisions.providerId)
  const http = decisions.http ?? { preset: "openrouter" as DecisionHttpPresetId }
  const preset = DECISION_HTTP_PRESETS[http.preset] ?? DECISION_HTTP_PRESETS.openrouter
  const isRemote = decisions.providerId === BUILTIN_HTTP_PROVIDER_ID

  const [keyDraft, setKeyDraft] = useState("")
  const [keyPresent, setKeyPresent] = useState<boolean | null>(null)
  const [keyError, setKeyError] = useState(false)
  const [revision, setRevision] = useState(0)
  const [test, setTest] = useState<TestState>({ kind: "idle" })
  const status = useProviderStatus(selected, revision)

  useEffect(() => {
    if (!isRemote) return
    let cancelled = false
    hasDecisionHttpKey(http.preset).then(
      (present) => {
        if (!cancelled) setKeyPresent(present)
      },
      () => {
        if (!cancelled) setKeyPresent(false)
      }
    )
    return () => {
      cancelled = true
    }
  }, [isRemote, http.preset, revision])

  function update(patch: Partial<DecisionSettings>): void {
    setTest({ kind: "idle" })
    void save({ decisions: { ...decisions, ...patch } })
  }

  function updateHttp(patch: Partial<NonNullable<DecisionSettings["http"]>>): void {
    update({ http: { ...http, ...patch } })
  }

  function providerLabel(provider: DecisionProvider): string {
    if (provider.id === BUILTIN_HTTP_PROVIDER_ID) return t("builtinRemote")
    if (!provider.pluginId) return provider.label
    return resolvePluginLabel(tRoot, provider.pluginId, provider.labelKey, provider.label)
  }

  async function saveKey(): Promise<void> {
    setKeyError(false)
    try {
      await setDecisionHttpKey(http.preset, keyDraft)
      setKeyDraft("")
      setRevision((r) => r + 1)
    } catch {
      setKeyError(true)
    }
  }

  async function runTest(): Promise<void> {
    if (!decisions.providerId) return
    setTest({ kind: "running" })
    const result = await runDecision(DECISION_PROBE_REQUEST, { providerId: decisions.providerId })
    if (result.ok) {
      setTest({ kind: "ok", latencyMs: result.latencyMs })
    } else {
      setTest({ kind: "failed", errorKind: result.error.kind })
    }
    setRevision((r) => r + 1)
  }

  const endpoint = isRemote ? resolveDecisionEndpoint(http) : null
  const missingProvider = Boolean(decisions.providerId) && !selected

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-medium">{t("title")}</h3>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>

      <div className="space-y-1">
        <Label htmlFor="decision-provider" className="text-sm">
          {t("provider.label")}
        </Label>
        <NativeSelect
          id="decision-provider"
          aria-label={t("provider.label")}
          size="sm"
          value={decisions.providerId ?? ""}
          onChange={(event) => update({ providerId: event.target.value || undefined })}
        >
          <NativeSelectOption value="">{t("provider.none")}</NativeSelectOption>
          {providers.map((provider) => (
            <NativeSelectOption key={provider.id} value={provider.id}>
              {providerLabel(provider)}
            </NativeSelectOption>
          ))}
          {missingProvider ? (
            <NativeSelectOption value={decisions.providerId}>
              {t("provider.missingOption", { id: decisions.providerId ?? "" })}
            </NativeSelectOption>
          ) : null}
        </NativeSelect>
        <p className="text-xs text-muted-foreground">
          {decisions.providerId ? t("provider.hint") : t("provider.noneHint")}
        </p>
      </div>

      {selected ? (
        <div className="flex flex-wrap items-center gap-2" data-testid="decision-provider-traits">
          <Badge variant="secondary">
            {selected.locality === "local" ? t("traits.local") : t("traits.remote")}
          </Badge>
          <Badge variant={selected.calibrated ? "secondary" : "outline"}>
            {selected.calibrated ? t("traits.calibrated") : t("traits.uncalibrated")}
          </Badge>
          {status?.kind === "checking" ? (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Spinner className="size-3" />
              {t("status.checking")}
            </span>
          ) : status?.kind === "known" ? (
            <span
              className={
                status.status.ready ? "text-xs text-muted-foreground" : "text-xs text-destructive"
              }
            >
              {status.status.ready
                ? t("status.ready")
                : status.status.loading
                  ? t("status.loading")
                  : t("status.notReady", { reason: status.status.message ?? "" })}
            </span>
          ) : null}
        </div>
      ) : null}

      {missingProvider ? <p className="text-xs text-destructive">{t("provider.missing")}</p> : null}

      {isRemote ? (
        <div className="space-y-3 rounded-md border p-3">
          <div className="space-y-1">
            <Label htmlFor="decision-http-preset" className="text-xs">
              {t("http.preset")}
            </Label>
            <NativeSelect
              id="decision-http-preset"
              aria-label={t("http.preset")}
              size="sm"
              value={http.preset}
              onChange={(event) =>
                updateHttp({ preset: event.target.value as DecisionHttpPresetId })
              }
            >
              {DECISION_HTTP_PRESET_IDS.map((id) => (
                <NativeSelectOption key={id} value={id}>
                  {t(`http.presets.${id}`)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <div className="space-y-1">
            <Label htmlFor="decision-http-url" className="text-xs">
              {t("http.url")}
            </Label>
            <Input
              id="decision-http-url"
              aria-label={t("http.url")}
              className="h-8 text-xs"
              placeholder={preset.url ?? t("http.urlRequired")}
              value={http.url ?? ""}
              onChange={(event) => updateHttp({ url: event.target.value || undefined })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="decision-http-model" className="text-xs">
              {t("http.model")}
            </Label>
            <Input
              id="decision-http-model"
              aria-label={t("http.model")}
              className="h-8 text-xs"
              placeholder={preset.defaultModel ?? t("http.modelRequired")}
              value={http.model ?? ""}
              onChange={(event) => updateHttp({ model: event.target.value || undefined })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="decision-http-key" className="text-xs">
              {t("http.key")}
            </Label>
            <div className="flex gap-2">
              <Input
                id="decision-http-key"
                aria-label={t("http.key")}
                type="password"
                autoComplete="off"
                className="h-8 text-xs"
                placeholder={keyPresent ? t("http.keySaved") : t("http.keyPlaceholder")}
                value={keyDraft}
                onChange={(event) => setKeyDraft(event.target.value)}
              />
              <Button type="button" size="sm" variant="outline" onClick={() => void saveKey()}>
                {keyDraft.trim() ? t("http.saveKey") : t("http.clearKey")}
              </Button>
            </div>
            {keyError ? (
              <p className="text-xs text-destructive">{t("http.keyringUnavailable")}</p>
            ) : null}
            {preset.keyUrl ? (
              <p className="text-xs text-muted-foreground">
                {t("http.keyHint", { url: preset.keyUrl })}
              </p>
            ) : null}
          </div>
          {endpoint && !endpoint.ok ? (
            <p className="text-xs text-destructive">{t(`http.problems.${endpoint.reason}`)}</p>
          ) : null}
        </div>
      ) : null}

      {decisions.providerId ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={test.kind === "running" || missingProvider}
            onClick={() => void runTest()}
          >
            {test.kind === "running" ? <Spinner className="size-3" /> : null}
            {t("test.button")}
          </Button>
          {test.kind === "ok" ? (
            <span className="text-xs text-muted-foreground">
              {t("test.ok", { latencyMs: test.latencyMs })}
            </span>
          ) : test.kind === "failed" ? (
            <span className="text-xs text-destructive">{t(`errors.${test.errorKind}`)}</span>
          ) : null}
        </div>
      ) : null}

      <p className="text-xs text-muted-foreground">{t("privacy")}</p>
    </div>
  )
}
