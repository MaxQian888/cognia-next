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

function withExtraHeader(src: CustomLimitsSource, name: string, value: string): CustomLimitsSource {
  const headers = { ...(src.request.headers ?? {}) }
  // Drop any prior non-Authorization custom header before re-adding. The header
  // is stored as soon as a name is typed (value may still be empty) so the
  // controlled inputs accumulate; empty entries are harmless at request time.
  for (const k of Object.keys(headers)) if (k !== "Authorization") delete headers[k]
  if (name.trim()) headers[name.trim()] = value
  return { ...src, request: { ...src.request, headers } }
}

function extraHeaderOf(src: CustomLimitsSource): { name: string; value: string } {
  const entry = Object.entries(src.request.headers ?? {}).find(([k]) => k !== "Authorization")
  return entry ? { name: entry[0], value: entry[1] } : { name: "", value: "" }
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
  const [seed, setSeed] = useState(1)
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
    setDraft(emptyCustomSource(newCustomSourceId(seed)))
    setSeed((n) => n + 1)
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
  const extra = extraHeaderOf(draft)
  const complete = isCustomSourceComplete(draft)

  // Apply a preset template onto the draft (preserves name/baseUrl/token).
  const applyPreset = (id: string) => {
    setPresetId(id)
    setDraft(presetById(id).apply(draft))
  }

  const field = (key: keyof CustomLimitsSource, value: string) =>
    setDraft({ ...draft, [key]: value })

  // Window editor operates on the single window the form exposes.
  const windowSpec = draft.extract.kind === "window" ? draft.extract.windows[0] : undefined
  const setWindow = (patch: Partial<WindowSpec>) =>
    setDraft({
      ...draft,
      extract: {
        kind: "window",
        windows: [
          {
            id: "window",
            labelKey: "window",
            usedPctPath: "",
            resetUnit: "unix",
            ...windowSpec,
            ...patch,
          },
        ],
      },
    })

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

      <div className="grid grid-cols-2 gap-2">
        <Field id="cs-hname" label={t("fields.extraHeaderName")}>
          <Input
            id="cs-hname"
            value={extra.name}
            placeholder="New-Api-User"
            onChange={(e) => setDraft(withExtraHeader(draft, e.target.value, extra.value))}
          />
        </Field>
        <Field id="cs-hval" label={t("fields.extraHeaderValue")}>
          <Input
            id="cs-hval"
            value={extra.value}
            onChange={(e) => setDraft(withExtraHeader(draft, extra.name, e.target.value))}
          />
        </Field>
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
        <div className="grid grid-cols-2 gap-2">
          <Field id="cs-wlabel" label={t("fields.windowLabel")}>
            <Input
              id="cs-wlabel"
              value={windowSpec?.id ?? ""}
              onChange={(e) => setWindow({ id: e.target.value, labelKey: e.target.value })}
            />
          </Field>
          <Field id="cs-wpct" label={t("fields.usedPctPath")}>
            <Input
              id="cs-wpct"
              value={windowSpec?.usedPctPath ?? ""}
              // i18n-exempt: example JSONPath selector into the API response, not UI prose
              placeholder="rate_limit.primary.used_percent"
              onChange={(e) => setWindow({ usedPctPath: e.target.value })}
            />
          </Field>
          <Field id="cs-wused" label={t("fields.usedPath")}>
            <Input
              id="cs-wused"
              value={windowSpec?.usedPath ?? ""}
              // i18n-exempt: example JSONPath selector into the API response, not UI prose
              placeholder="data.used"
              onChange={(e) => setWindow({ usedPath: e.target.value })}
            />
          </Field>
          <Field id="cs-wtotal" label={t("fields.totalPath")}>
            <Input
              id="cs-wtotal"
              value={windowSpec?.totalPath ?? ""}
              // i18n-exempt: example JSONPath selector into the API response, not UI prose
              placeholder="data.total"
              onChange={(e) => setWindow({ totalPath: e.target.value })}
            />
          </Field>
          <Field id="cs-wremaining" label={t("fields.remainingPath")}>
            <Input
              id="cs-wremaining"
              value={windowSpec?.remainingPath ?? ""}
              onChange={(e) => setWindow({ remainingPath: e.target.value })}
            />
          </Field>
          <Field id="cs-wreset" label={t("fields.resetAtPath")}>
            <Input
              id="cs-wreset"
              value={windowSpec?.resetAtPath ?? ""}
              onChange={(e) => setWindow({ resetAtPath: e.target.value })}
            />
          </Field>
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
