"use client"

/**
 * Custom limits sources card (Settings → Subscription → Settings tab).
 *
 * Lets a user wire ANY coding-plan / relay provider into the unified limits
 * panel as data — no code. Each source is a self-contained descriptor (its own
 * baseUrl + token + extract paths) persisted in `AppSettings.customLimitsSources`
 * and run by the custom runner (`lib/subscription/limits/custom/runner.ts`). The
 * "Test" button runs the descriptor once and shows the resulting meter so the
 * user can verify their paths before saving.
 *
 * Security: the token is stored in the renderer settings store (not the OS
 * keyring) — the card surfaces a caveat. This mirrors the CLI's plaintext
 * provider tokens.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { PlusIcon, TrashIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { SettingsAlert, SettingsCard } from "@/components/settings/common/settings-section"

import { isTauri } from "@/lib/tauri"
import { authedGet } from "@/lib/subscription/core/transport"
import {
  CUSTOM_LIMITS_MAX_REFRESH_MS,
  CUSTOM_LIMITS_MIN_REFRESH_MS,
  emptyCustomSource,
  isCustomSourceComplete,
  newCustomSourceId,
  removeCustomSource,
  upsertCustomSource,
} from "@/lib/subscription/limits/custom/store"
import { runCustomLimitsSource } from "@/lib/subscription/limits/custom/runner"
import { CUSTOM_SOURCE_PRESETS, presetById } from "@/lib/subscription/limits/custom/presets"
import { useSettingsStore } from "@/stores/settings/settings-store"

import type {
  CustomLimitsSource,
  DescriptorExtract,
  ProviderLimits,
  WindowSpec,
} from "@/types/subscription"

type AuthStyle = "bearer" | "raw"

function authStyleOf(src: CustomLimitsSource): AuthStyle {
  const auth = src.request.headers?.Authorization
  return auth && !/^Bearer\b/i.test(auth) ? "raw" : "bearer"
}

/** Apply an auth style by mutating the (copied) headers map. */
function withAuthStyle(src: CustomLimitsSource, style: AuthStyle): CustomLimitsSource {
  const headers = { ...(src.request.headers ?? {}) }
  if (style === "raw") headers.Authorization = "{{token}}"
  else delete headers.Authorization // bearer is the engine default
  return { ...src, request: { ...src.request, headers } }
}

type ExtraHeader = { name: string; value: string }

function extraHeadersOf(src: CustomLimitsSource): ExtraHeader[] {
  const headers = Object.entries(src.request.headers ?? {})
    .filter(([name]) => name.toLowerCase() !== "authorization")
    .map(([name, value]) => ({ name, value }))
  return headers.length ? headers : [{ name: "", value: "" }]
}

function setExtract(
  src: CustomLimitsSource,
  patch: Partial<DescriptorExtract>
): CustomLimitsSource {
  return { ...src, extract: { ...src.extract, ...patch } as DescriptorExtract }
}

export function CustomSourcesCard() {
  const t = useTranslations("subscription.customSources")
  const ready = isTauri()
  const sources = useSettingsStore((s) => s.settings?.customLimitsSources) ?? []
  const save = useSettingsStore((s) => s.save)

  const [draft, setDraft] = useState<CustomLimitsSource | null>(null)
  const [testResult, setTestResult] = useState<ProviderLimits | null>(null)
  const [tested, setTested] = useState(false)
  const [testing, setTesting] = useState(false)

  const clearTest = () => {
    setTestResult(null)
    setTested(false)
  }

  const persist = async (next: CustomLimitsSource[]) => {
    await save({ customLimitsSources: next })
  }

  const onAdd = () => {
    setDraft(emptyCustomSource(newCustomSourceId()))
    clearTest()
  }

  const onEdit = (src: CustomLimitsSource) => {
    setDraft(src)
    clearTest()
  }

  const onRemove = async (id: string) => {
    await persist(removeCustomSource(sources, id))
    if (draft?.id === id) setDraft(null)
  }

  const onToggle = async (src: CustomLimitsSource, enabled: boolean) => {
    await persist(upsertCustomSource(sources, { ...src, enabled }))
  }

  const onSave = async () => {
    if (!draft) return
    await persist(upsertCustomSource(sources, draft))
    setDraft(null)
    clearTest()
  }

  const onTest = async () => {
    if (!draft) return
    setTesting(true)
    setTestResult(null)
    try {
      const result = await runCustomLimitsSource(draft, { authedGet, now: () => Date.now() })
      setTestResult(result)
      setTested(true)
    } finally {
      setTesting(false)
    }
  }

  if (!ready) {
    return (
      <SettingsCard title={t("title")} description={t("description")}>
        <SettingsAlert title={t("title")}>{t("webModeHint")}</SettingsAlert>
      </SettingsCard>
    )
  }

  return (
    <SettingsCard title={t("title")} description={t("description")}>
      <div className="space-y-3">
        <p className="text-xs text-amber-600 dark:text-amber-500">{t("securityCaveat")}</p>

        {sources.length === 0 && !draft ? (
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        ) : (
          <ul className="space-y-2">
            {sources.map((src) => (
              <li
                key={src.id}
                className="flex items-center justify-between gap-2 rounded-md border px-3 py-2"
                data-testid={`custom-source-${src.id}`}
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{src.name || src.id}</p>
                  <p className="truncate text-xs text-muted-foreground">{src.baseUrl}</p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Switch
                    checked={src.enabled === true}
                    aria-label={
                      src.enabled
                        ? t("disableSource", { name: src.name || src.id })
                        : t("enableSource", { name: src.name || src.id })
                    }
                    onCheckedChange={(enabled) => void onToggle(src, enabled)}
                  />
                  <Button variant="ghost" size="sm" onClick={() => onEdit(src)}>
                    {t("edit")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t("remove")}
                    onClick={() => onRemove(src.id)}
                  >
                    <TrashIcon className="size-4" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {draft ? (
          <SourceForm
            key={draft.id}
            draft={draft}
            setDraft={setDraft}
            onSave={onSave}
            onCancel={() => {
              setDraft(null)
              clearTest()
            }}
            onTest={onTest}
            testing={testing}
            tested={tested}
            testResult={testResult}
          />
        ) : (
          <Button variant="outline" size="sm" onClick={onAdd}>
            <PlusIcon className="mr-1 size-4" />
            {t("add")}
          </Button>
        )}
      </div>
    </SettingsCard>
  )
}

function SourceForm({
  draft,
  setDraft,
  onSave,
  onCancel,
  onTest,
  testing,
  tested,
  testResult,
}: {
  draft: CustomLimitsSource
  setDraft: (s: CustomLimitsSource) => void
  onSave: () => void
  onCancel: () => void
  onTest: () => void
  testing: boolean
  tested: boolean
  testResult: ProviderLimits | null
}) {
  const t = useTranslations("subscription.customSources")
  const [presetId, setPresetId] = useState("custom")
  const [extraHeaders, setExtraHeaders] = useState(() => extraHeadersOf(draft))
  const updateHeaders = (next: ExtraHeader[]) => {
    setExtraHeaders(next)
    const headers = Object.fromEntries(
      Object.entries(draft.request.headers ?? {}).filter(
        ([name]) => name.toLowerCase() === "authorization"
      )
    )
    for (const { name, value } of next) {
      if (name.trim() && name.trim().toLowerCase() !== "authorization") {
        headers[name.trim()] = value
      }
    }
    setDraft({ ...draft, request: { ...draft.request, headers } })
  }
  const headerNames = extraHeaders.map(({ name }) => name.trim().toLowerCase()).filter(Boolean)
  const validHeaders =
    !headerNames.includes("authorization") && new Set(headerNames).size === headerNames.length
  const complete = isCustomSourceComplete(draft) && validHeaders

  // Apply a preset template onto the draft (preserves name/baseUrl/token).
  const applyPreset = (id: string) => {
    setPresetId(id)
    const next = presetById(id).apply(draft)
    setExtraHeaders(extraHeadersOf(next))
    setDraft(next)
  }

  const field = (key: keyof CustomLimitsSource, value: string) =>
    setDraft({ ...draft, [key]: value })

  const windows = draft.extract.kind === "window" ? draft.extract.windows : []
  const setWindows = (next: WindowSpec[]) =>
    setDraft({ ...draft, extract: { ...draft.extract, kind: "window", windows: next } })
  const setWindow = (index: number, patch: Partial<WindowSpec>) =>
    setWindows(windows.map((window, i) => (i === index ? { ...window, ...patch } : window)))

  return (
    <div className="space-y-3 rounded-md border p-3" data-testid="custom-source-form">
      <Field id="cs-preset" label={t("presets.label")}>
        <Select value={presetId} onValueChange={applyPreset}>
          <SelectTrigger id="cs-preset">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CUSTOM_SOURCE_PRESETS.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {t(p.labelKey.replace("subscription.customSources.", ""))}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <div className="grid grid-cols-2 gap-2">
        <Field id="cs-name" label={t("fields.name")}>
          <Input
            id="cs-name"
            value={draft.name}
            placeholder={t("fields.namePlaceholder")}
            onChange={(e) => field("name", e.target.value)}
          />
        </Field>
        <Field id="cs-base" label={t("fields.baseUrl")}>
          <Input
            id="cs-base"
            value={draft.baseUrl}
            placeholder="https://relay.example.com/v1"
            onChange={(e) => field("baseUrl", e.target.value)}
          />
        </Field>
        <Field id="cs-token" label={t("fields.token")}>
          <Input
            id="cs-token"
            type="password"
            value={draft.token}
            placeholder={t("fields.tokenPlaceholder")}
            onChange={(e) => field("token", e.target.value)}
          />
        </Field>
        <Field id="cs-path" label={t("fields.path")}>
          <Input
            id="cs-path"
            value={draft.request.path}
            // i18n-exempt: example API path the user types verbatim, not UI prose
            placeholder="/user/balance"
            onChange={(e) =>
              setDraft({ ...draft, request: { ...draft.request, path: e.target.value } })
            }
          />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Field id="cs-refresh" label={t("fields.refreshMinutes")}>
          <Input
            id="cs-refresh"
            type="number"
            min={CUSTOM_LIMITS_MIN_REFRESH_MS / 60_000}
            max={CUSTOM_LIMITS_MAX_REFRESH_MS / 60_000}
            value={Math.round((draft.refreshIntervalMs ?? CUSTOM_LIMITS_MIN_REFRESH_MS) / 60_000)}
            onChange={(e) => {
              const minutes = Math.max(
                CUSTOM_LIMITS_MIN_REFRESH_MS / 60_000,
                Math.min(
                  CUSTOM_LIMITS_MAX_REFRESH_MS / 60_000,
                  Number(e.target.value) || CUSTOM_LIMITS_MIN_REFRESH_MS / 60_000
                )
              )
              setDraft({ ...draft, refreshIntervalMs: minutes * 60_000 })
            }}
          />
        </Field>
        <Field id="cs-enabled" label={t("fields.enabled")}>
          <Switch
            id="cs-enabled"
            checked={draft.enabled === true}
            onCheckedChange={(enabled) => setDraft({ ...draft, enabled })}
          />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Field id="cs-auth" label={t("fields.auth")}>
          <Select
            value={authStyleOf(draft)}
            onValueChange={(v) => setDraft(withAuthStyle(draft, v as AuthStyle))}
          >
            <SelectTrigger id="cs-auth">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="bearer">{t("fields.authBearer")}</SelectItem>
              <SelectItem value="raw">{t("fields.authRaw")}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field id="cs-kind" label={t("fields.kind")}>
          <Select
            value={draft.extract.kind}
            onValueChange={(v) =>
              setDraft(
                v === "window"
                  ? {
                      ...draft,
                      extract: {
                        kind: "window",
                        windows: [
                          { id: "window", labelKey: "window", usedPctPath: "", resetUnit: "unix" },
                        ],
                      },
                    }
                  : { ...draft, extract: { kind: "balance", remainingPath: "" } }
              )
            }
          >
            <SelectTrigger id="cs-kind">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="balance">{t("fields.kindBalance")}</SelectItem>
              <SelectItem value="window">{t("fields.kindWindow")}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </div>

      <div className="space-y-2">
        {extraHeaders.map((extra, index) => (
          <div key={index} className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
            <Field id={`cs-hname-${index}`} label={t("fields.extraHeaderName")}>
              <Input
                id={`cs-hname-${index}`}
                value={extra.name}
                // i18n-exempt: HTTP header-name example
                placeholder="New-Api-User"
                onChange={(e) =>
                  updateHeaders(
                    extraHeaders.map((header, i) =>
                      i === index ? { ...header, name: e.target.value } : header
                    )
                  )
                }
              />
            </Field>
            <Field id={`cs-hval-${index}`} label={t("fields.extraHeaderValue")}>
              <Input
                id={`cs-hval-${index}`}
                value={extra.value}
                onChange={(e) =>
                  updateHeaders(
                    extraHeaders.map((header, i) =>
                      i === index ? { ...header, value: e.target.value } : header
                    )
                  )
                }
              />
            </Field>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("removeHeader", { index: index + 1 })}
              onClick={() => updateHeaders(extraHeaders.filter((_, i) => i !== index))}
            >
              <TrashIcon className="size-4" />
            </Button>
          </div>
        ))}
        {!validHeaders && <p className="text-xs text-destructive">{t("invalidHeaders")}</p>}
        <Button
          variant="outline"
          size="sm"
          onClick={() => setExtraHeaders([...extraHeaders, { name: "", value: "" }])}
        >
          {t("addHeader")}
        </Button>
      </div>

      {draft.extract.kind === "balance" ? (
        <div className="grid grid-cols-2 gap-2">
          <Field id="cs-remaining" label={t("fields.remainingPath")}>
            <Input
              id="cs-remaining"
              value={draft.extract.remainingPath ?? ""}
              // i18n-exempt: example JSONPath selector into the API response, not UI prose
              placeholder="data.balance"
              onChange={(e) => setDraft(setExtract(draft, { remainingPath: e.target.value }))}
            />
          </Field>
          <Field id="cs-total" label={t("fields.totalPath")}>
            <Input
              id="cs-total"
              value={draft.extract.totalPath ?? ""}
              onChange={(e) => setDraft(setExtract(draft, { totalPath: e.target.value }))}
            />
          </Field>
          <Field id="cs-used" label={t("fields.usedPath")}>
            <Input
              id="cs-used"
              value={draft.extract.usedPath ?? ""}
              // i18n-exempt: example JSONPath selector into the API response, not UI prose
              placeholder="data.used_quota"
              onChange={(e) => setDraft(setExtract(draft, { usedPath: e.target.value }))}
            />
          </Field>
          <Field id="cs-unit" label={t("fields.unit")}>
            <Input
              id="cs-unit"
              value={draft.extract.unit ?? ""}
              // i18n-exempt: example currency-unit token the user types verbatim, not UI prose
              placeholder="USD"
              onChange={(e) => setDraft(setExtract(draft, { unit: e.target.value }))}
            />
          </Field>
          <Field id="cs-scale" label={t("fields.scale")}>
            <Input
              id="cs-scale"
              type="number"
              value={draft.extract.scale ?? 1}
              onChange={(e) => setDraft(setExtract(draft, { scale: Number(e.target.value) }))}
            />
          </Field>
        </div>
      ) : (
        <div className="space-y-3">
          {windows.map((windowSpec, index) => (
            <fieldset key={index} className="space-y-2 rounded-md border p-3">
              <legend className="px-1 text-xs">{t("windowNumber", { index: index + 1 })}</legend>
              <div className="grid grid-cols-2 gap-2">
                <Field id={`cs-wlabel-${index}`} label={t("fields.windowLabel")}>
                  <Input
                    id={`cs-wlabel-${index}`}
                    value={windowSpec.id ?? ""}
                    onChange={(e) =>
                      setWindow(index, { id: e.target.value, labelKey: e.target.value })
                    }
                  />
                </Field>
                <Field id={`cs-wpct-${index}`} label={t("fields.usedPctPath")}>
                  <Input
                    id={`cs-wpct-${index}`}
                    value={windowSpec.usedPctPath ?? ""}
                    // i18n-exempt: example JSONPath selector into the API response, not UI prose
                    placeholder="rate_limit.primary.used_percent"
                    onChange={(e) => setWindow(index, { usedPctPath: e.target.value })}
                  />
                </Field>
                <Field id={`cs-wused-${index}`} label={t("fields.usedPath")}>
                  <Input
                    id={`cs-wused-${index}`}
                    value={windowSpec.usedPath ?? ""}
                    // i18n-exempt: example JSONPath selector into the API response, not UI prose
                    placeholder="data.used"
                    onChange={(e) => setWindow(index, { usedPath: e.target.value })}
                  />
                </Field>
                <Field id={`cs-wtotal-${index}`} label={t("fields.totalPath")}>
                  <Input
                    id={`cs-wtotal-${index}`}
                    value={windowSpec.totalPath ?? ""}
                    // i18n-exempt: example JSONPath selector into the API response, not UI prose
                    placeholder="data.total"
                    onChange={(e) => setWindow(index, { totalPath: e.target.value })}
                  />
                </Field>
                <Field id={`cs-wremaining-${index}`} label={t("fields.remainingPath")}>
                  <Input
                    id={`cs-wremaining-${index}`}
                    value={windowSpec.remainingPath ?? ""}
                    onChange={(e) => setWindow(index, { remainingPath: e.target.value })}
                  />
                </Field>
                <Field id={`cs-wreset-${index}`} label={t("fields.resetAtPath")}>
                  <Input
                    id={`cs-wreset-${index}`}
                    value={windowSpec.resetAtPath ?? ""}
                    onChange={(e) => setWindow(index, { resetAtPath: e.target.value })}
                  />
                </Field>
              </div>
              <Button
                variant="ghost"
                size="sm"
                disabled={windows.length === 1}
                onClick={() => setWindows(windows.filter((_, i) => i !== index))}
              >
                {t("removeWindow", { index: index + 1 })}
              </Button>
            </fieldset>
          ))}
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setWindows([
                ...windows,
                { id: newCustomSourceId(), labelKey: "window", usedPctPath: "", resetUnit: "unix" },
              ])
            }
          >
            {t("addWindow")}
          </Button>
        </div>
      )}

      {tested && (
        <p className="text-xs" data-testid="custom-source-test-result">
          {testResult?.error
            ? t("testError", { error: testResult.error })
            : !testResult || testResult.meters.length === 0
              ? t("testNoData")
              : t("testOk", {
                  summary: testResult.meters
                    .map((m) =>
                      m.kind === "balance"
                        ? `${m.remaining ?? "?"}${m.unit ? ` ${m.unit}` : ""}`
                        : `${m.usedPct ?? "?"}%`
                    )
                    .join(", "),
                })}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t("cancel")}
        </Button>
        <Button variant="outline" size="sm" onClick={onTest} disabled={!complete || testing}>
          {testing ? t("testing") : t("test")}
        </Button>
        <Button size="sm" onClick={onSave} disabled={!complete}>
          {t("save")}
        </Button>
      </div>
    </div>
  )
}

function Field({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      {children}
    </div>
  )
}
