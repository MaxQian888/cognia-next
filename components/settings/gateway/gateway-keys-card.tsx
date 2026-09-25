"use client"

/**
 * Gateway API keys manager (desktop only).
 *
 * Issues, scopes, edits, toggles, copies, and deletes the keyring-backed API
 * keys the inbound gateway authenticates against — the newapi "Tokens"
 * equivalent. Each key carries an optional model allowlist, expiry, per-minute
 * rate limit, and a cumulative token quota (drawn down per request; the gateway
 * rejects a key that has spent its budget). A freshly created key's secret is
 * shown exactly once (create returns the full value; every list afterwards is
 * redacted to a fingerprint).
 *
 * A key also carries Run API scopes (ADR-0188 D8). A new key gets none, so it
 * is passthrough-only — the chat endpoints exactly as before — until someone
 * grants it what it needs here. Nothing about a scopeless key changes.
 *
 * Each row also shows what the key has done recently, rolled up from the
 * durable request log by `summarizePerKeyUsage` — which was written for this
 * surface and had never been called.
 */

import { useEffect, useMemo, useState } from "react"
import { useFormatter, useNow, useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import {
  CopyIcon,
  KeyRoundIcon,
  Loader2Icon,
  LockIcon,
  PencilIcon,
  PlusIcon,
  RotateCcwIcon,
  Trash2Icon,
} from "lucide-react"
import { toast } from "sonner"

import { Snippet, SnippetCopyButton, SnippetInput } from "@/components/ai-elements/snippet"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Item, ItemActions, ItemContent, ItemGroup, ItemTitle } from "@/components/ui/item"
import { Progress } from "@/components/ui/progress"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { MotionCollapse, MotionReveal } from "@/components/chat/motion/motion-reveal"
import { SettingsEmptyState } from "@/components/settings/common/settings-section"
import { listGatewayRequestLog, summarizePerKeyUsage } from "@/lib/db/gateway-request-log"
import {
  gatewayCreateKey,
  gatewayDeleteKey,
  gatewayListKeys,
  gatewayResetKeyQuota,
  gatewayRevealKey,
  gatewayUpdateKey,
} from "@/lib/tauri/gateway"
import { cn } from "@/lib/utils"
import {
  GATEWAY_RUN_API_SCOPES,
  type GatewayApiKey,
  type GatewayApiKeyRedacted,
  type GatewayRunApiScope,
} from "@/types/gateway"

import { GatewayPanelSection, GatewayPanelStack } from "./shared/panel-section"
import { SinceTime } from "./shared/since-time"

/** How many of the newest log rows the per-key usage line is computed over. */
export const KEY_USAGE_WINDOW = 500

/** Quota share at which the usage bar turns to a warning. */
const QUOTA_WARN_RATIO = 0.8

function parseCsv(value: string): string[] {
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
}

/** Parse a positive-integer field, or `null` when blank/invalid. */
function parsePositiveInt(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const n = Number.parseInt(trimmed, 10)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** Date input (yyyy-mm-dd) → epoch ms at end-of-day, or `null` when blank. */
function parseExpiry(value: string): number | null {
  return value ? new Date(`${value}T23:59:59`).getTime() : null
}

/** Epoch ms → yyyy-mm-dd for a date input, or "" when unset. */
function toDateInput(ms: number | null): string {
  if (ms == null) return ""
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

interface KeyDraft {
  name: string
  models: string
  expiry: string
  rate: string
  quota: string
}

interface EditDraft extends KeyDraft {
  scopes: GatewayRunApiScope[]
}

const EMPTY_DRAFT: KeyDraft = { name: "", models: "", expiry: "", rate: "", quota: "" }

export function GatewayKeysCard({
  onChanged,
  legacyKeyCount = 0,
  accountLocked = false,
}: {
  onChanged?: () => void
  legacyKeyCount?: number
  /**
   * An account-scoped gateway with no unlocked account: Rust lists no keys and
   * refuses to create one, so an empty list here means "locked", not "none".
   */
  accountLocked?: boolean
}) {
  const t = useTranslations("settings.gateway")
  const format = useFormatter()
  const now = useNow({ updateInterval: 60_000 })
  const [keys, setKeys] = useState<GatewayApiKeyRedacted[]>([])
  const [freshKey, setFreshKey] = useState<GatewayApiKey | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [editId, setEditId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null)
  const [editNameError, setEditNameError] = useState(false)
  /** The key whose mutation is in flight; its controls lock until it lands. */
  const [busyId, setBusyId] = useState<string | null>(null)

  const [draft, setDraft] = useState<KeyDraft>(EMPTY_DRAFT)
  const [nameError, setNameError] = useState(false)
  const [creating, setCreating] = useState(false)

  const recentRows = useLiveQuery(() => listGatewayRequestLog({ limit: KEY_USAGE_WINDOW }), [])
  const usageByKey = useMemo(() => summarizePerKeyUsage(recentRows ?? []), [recentRows])

  const refresh = () =>
    gatewayListKeys()
      .then(setKeys)
      .catch(() => {})

  useEffect(() => {
    // setState in the promise callback — an external-system update, not a
    // synchronous effect-body write (react-hooks/set-state-in-effect).
    gatewayListKeys()
      .then(setKeys)
      .catch(() => {})
  }, [])

  /** Run one key's mutation with its controls locked; report failures. */
  const mutate = async (id: string, run: () => Promise<void>) => {
    setBusyId(id)
    try {
      await run()
      await refresh()
      onChanged?.()
      return true
    } catch (e) {
      toast.error(errMsg(e))
      return false
    } finally {
      setBusyId(null)
    }
  }

  const onCreate = async () => {
    if (!draft.name.trim()) {
      setNameError(true)
      return
    }
    setCreating(true)
    try {
      const created = await gatewayCreateKey({
        name: draft.name.trim(),
        modelAllowlist: parseCsv(draft.models),
        expiresAtMs: parseExpiry(draft.expiry),
        rateLimitPerMin: parsePositiveInt(draft.rate),
        quotaTokens: parsePositiveInt(draft.quota),
      })
      setFreshKey(created)
      setDraft(EMPTY_DRAFT)
      await refresh()
      onChanged?.()
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setCreating(false)
    }
  }

  const startEdit = (k: GatewayApiKeyRedacted) => {
    setConfirmDeleteId(null)
    setEditNameError(false)
    setEditId(k.id)
    setEditDraft({
      name: k.name,
      models: k.modelAllowlist.join(", "),
      scopes: [...k.scopes],
      expiry: toDateInput(k.expiresAtMs),
      rate: k.rateLimitPerMin != null ? String(k.rateLimitPerMin) : "",
      quota: k.quotaTokens != null ? String(k.quotaTokens) : "",
    })
  }

  const closeEdit = () => {
    setEditId(null)
    setEditDraft(null)
    setEditNameError(false)
  }

  const onSaveEdit = async (id: string) => {
    if (!editDraft) return
    if (!editDraft.name.trim()) {
      setEditNameError(true)
      return
    }
    const saved = await mutate(id, () =>
      gatewayUpdateKey(id, {
        name: editDraft.name.trim(),
        modelAllowlist: parseCsv(editDraft.models),
        scopes: editDraft.scopes,
        // `null` explicitly clears the optional value.
        expiresAtMs: parseExpiry(editDraft.expiry),
        rateLimitPerMin: parsePositiveInt(editDraft.rate),
        quotaTokens: parsePositiveInt(editDraft.quota),
      })
    )
    if (saved) {
      closeEdit()
      toast.success(t("saved"))
    }
  }

  const onResetQuota = async (id: string) => {
    if (await mutate(id, () => gatewayResetKeyQuota(id))) toast.success(t("quotaReset"))
  }

  const onDelete = async (id: string) => {
    if (await mutate(id, () => gatewayDeleteKey(id))) setConfirmDeleteId(null)
  }

  const onCopySecret = async (id: string) => {
    try {
      const secret = await gatewayRevealKey(id)
      if (!secret) {
        toast.error(t("copyFailed"))
        return
      }
      await navigator.clipboard.writeText(secret)
      toast.success(t("keyCopied"))
    } catch (e) {
      // Reported as a failure, not swallowed: the old path toasted "copied"
      // even when the clipboard write had been refused.
      toast.error(e instanceof Error ? e.message : t("copyFailed"))
    }
  }

  return (
    <GatewayPanelStack>
      {accountLocked ? (
        <Alert data-testid="gateway-keys-locked">
          <LockIcon />
          <AlertDescription>{t("accountLocked")}</AlertDescription>
        </Alert>
      ) : null}
      {legacyKeyCount > 0 && (
        <Alert>
          <KeyRoundIcon />
          <AlertTitle>{t("legacyKeysHeading")}</AlertTitle>
          <AlertDescription>{t("legacyKeysHelp", { count: legacyKeyCount })}</AlertDescription>
        </Alert>
      )}
      <GatewayPanelSection
        icon={<KeyRoundIcon className="size-4" />}
        title={t("keysHeading")}
        description={t("keysHelp")}
        badge={keys.length > 0 ? String(keys.length) : undefined}
      >
        {/* The freshly-minted secret is shown exactly once, so it slides in
          rather than popping — the entrance is what draws the eye to the one
          thing on this screen that cannot be recovered later. */}
        <MotionCollapse open={freshKey !== null}>
          {freshKey ? (
            <Alert data-testid="gateway-fresh-key">
              <KeyRoundIcon />
              <AlertTitle>{t("newKeyHeading")}</AlertTitle>
              <AlertDescription className="w-full gap-2">
                <div className="flex w-full min-w-0 flex-col gap-2 @md/gateway-pane:flex-row">
                  <Snippet code={freshKey.secret} className="min-w-0 flex-1">
                    <SnippetInput aria-label={t("newKeyHeading")} className="text-xs" />
                    <SnippetCopyButton
                      aria-label={t("copyKey")}
                      title={t("copyKey")}
                      onCopy={() => toast.success(t("keyCopied"))}
                      onError={(error) =>
                        toast.error(error instanceof Error ? error.message : t("copyFailed"))
                      }
                    />
                  </Snippet>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="self-end @md/gateway-pane:self-auto"
                    onClick={() => setFreshKey(null)}
                  >
                    {t("hide")}
                  </Button>
                </div>
                <p>{t("newKeyReveal")}</p>
              </AlertDescription>
            </Alert>
          ) : null}
        </MotionCollapse>

        {keys.length === 0 ? (
          <SettingsEmptyState
            icon={<KeyRoundIcon className="size-5" />}
            title={t(accountLocked ? "keysLockedEmpty" : "keysEmpty")}
            className="py-6"
          />
        ) : (
          <ItemGroup className="gap-2" data-testid="gateway-keys">
            {keys.map((k, index) => {
              const expired = k.expiresAtMs != null && k.expiresAtMs <= now.getTime()
              const overQuota = k.quotaTokens != null && k.quotaUsedTokens >= k.quotaTokens
              const quotaRatio =
                k.quotaTokens != null && k.quotaTokens > 0
                  ? Math.min(k.quotaUsedTokens / k.quotaTokens, 1)
                  : null
              const usage = usageByKey.get(k.id)
              const isEditing = editId === k.id
              const busy = busyId === k.id
              return (
                <MotionReveal key={k.id} index={index}>
                  <Item
                    role="listitem"
                    variant="muted"
                    className={cn("items-start gap-3", !k.enabled && "opacity-75")}
                    aria-busy={busy || undefined}
                  >
                    <ItemContent className="min-w-0 basis-60 gap-2">
                      <ItemTitle className="w-full min-w-0 flex-wrap">
                        <span className="truncate">{k.name}</span>
                        <Badge
                          variant="outline"
                          className="max-w-full truncate font-mono text-[10px] font-normal"
                        >
                          {k.secretPreview}
                        </Badge>
                        {!k.enabled && <Badge variant="outline">{t("keyDisabled")}</Badge>}
                        {expired && <Badge variant="destructive">{t("keyExpired")}</Badge>}
                        {overQuota && <Badge variant="destructive">{t("quotaExceeded")}</Badge>}
                      </ItemTitle>

                      <dl
                        className="grid grid-cols-1 gap-x-4 gap-y-1 text-[11px] @md/gateway-pane:grid-cols-2 @2xl/gateway-pane:grid-cols-3"
                        data-testid={`gateway-key-meta-${k.id}`}
                      >
                        <KeyMeta label={t("keyModels")}>
                          {k.modelAllowlist.length === 0
                            ? t("keyModelsAll")
                            : k.modelAllowlist.join(", ")}
                        </KeyMeta>
                        <KeyMeta label={t("keyScopes")}>
                          {k.scopes.length === 0 ? t("keyScopesNone") : k.scopes.join(", ")}
                        </KeyMeta>
                        <KeyMeta label={t("keyRateLimit")}>
                          {k.rateLimitPerMin ?? t("keyRateLimitNone")}
                        </KeyMeta>
                        <KeyMeta label={t("keyExpiry")}>
                          {k.expiresAtMs
                            ? format.dateTime(new Date(k.expiresAtMs), { dateStyle: "medium" })
                            : t("keyNeverExpires")}
                        </KeyMeta>
                        <KeyMeta label={t("keyLastUsed")}>
                          {k.lastUsedAtMs ? (
                            <SinceTime date={new Date(k.lastUsedAtMs)} now={now} />
                          ) : (
                            t("keyNeverUsed")
                          )}
                        </KeyMeta>
                        <KeyMeta label={t("keyCreated")}>
                          {format.dateTime(new Date(k.createdAtMs), { dateStyle: "medium" })}
                        </KeyMeta>
                        <KeyMeta label={t("keyRecentUsage")}>
                          <span data-testid={`gateway-key-usage-${k.id}`}>
                            {t("keyRecentUsageValue", {
                              requests: usage?.requests ?? 0,
                              errors: usage?.errors ?? 0,
                            })}
                          </span>
                        </KeyMeta>
                      </dl>

                      <div className="flex flex-col gap-1">
                        <p className="text-[11px] text-muted-foreground">
                          {t("keyQuota")}:{" "}
                          {k.quotaTokens != null
                            ? t("keyQuotaUsed", {
                                used: format.number(k.quotaUsedTokens),
                                total: format.number(k.quotaTokens),
                              })
                            : t("keyQuotaNone")}
                        </p>
                        {quotaRatio != null ? (
                          <Progress
                            value={Math.round(quotaRatio * 100)}
                            aria-label={t("keyQuota")}
                            className={cn(
                              "h-1.5",
                              quotaRatio >= 1
                                ? "[&_[data-slot=progress-indicator]]:bg-destructive"
                                : quotaRatio >= QUOTA_WARN_RATIO &&
                                    "[&_[data-slot=progress-indicator]]:bg-warning"
                            )}
                            data-testid={`gateway-key-quota-${k.id}`}
                          />
                        ) : null}
                      </div>
                    </ItemContent>

                    <ItemActions className="max-w-full flex-wrap justify-end">
                      <Switch
                        checked={k.enabled}
                        disabled={busy}
                        onCheckedChange={(enabled) =>
                          void mutate(k.id, () => gatewayUpdateKey(k.id, { enabled }))
                        }
                        aria-label={`${k.enabled ? t("disable") : t("enable")} ${k.name}`}
                      />
                      {k.quotaTokens != null && (
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => void onResetQuota(k.id)}
                          aria-label={`${t("resetQuota")} ${k.name}`}
                          title={t("resetQuota")}
                        >
                          <RotateCcwIcon className="size-3.5" aria-hidden />
                        </Button>
                      )}
                      <Button
                        size="icon-sm"
                        variant={isEditing ? "secondary" : "ghost"}
                        disabled={busy}
                        onClick={() => (isEditing ? closeEdit() : startEdit(k))}
                        aria-label={`${t("editKey")} ${k.name}`}
                        aria-expanded={isEditing}
                        title={t("editKey")}
                      >
                        <PencilIcon className="size-3.5" aria-hidden />
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => void onCopySecret(k.id)}
                        aria-label={`${t("copyKey")} ${k.name}`}
                        title={t("copyKey")}
                      >
                        <CopyIcon className="size-3.5" aria-hidden />
                      </Button>
                      {/* The trigger stays put whether or not the confirmation
                          is open. It used to be REPLACED by a wide destructive
                          button, so asking to delete visibly re-flowed the row
                          and moved every other control under the cursor. */}
                      <Button
                        size="icon-sm"
                        variant={confirmDeleteId === k.id ? "secondary" : "ghost"}
                        disabled={busy}
                        onClick={() => setConfirmDeleteId((cur) => (cur === k.id ? null : k.id))}
                        aria-label={`${t("deleteKey")} ${k.name}`}
                        aria-expanded={confirmDeleteId === k.id}
                        title={t("deleteKey")}
                      >
                        <Trash2Icon className="size-3.5" aria-hidden />
                      </Button>
                    </ItemActions>

                    <div className="w-full basis-full">
                      <MotionCollapse open={confirmDeleteId === k.id}>
                        <Alert variant="destructive" className="mt-1">
                          <AlertDescription className="flex w-full flex-col gap-2 @md/gateway-pane:flex-row @md/gateway-pane:items-center">
                            <p className="flex-1">{t("deleteKeyConfirm")}</p>
                            <div className="flex flex-wrap gap-2">
                              <Button
                                size="sm"
                                variant="destructive"
                                disabled={busy}
                                onClick={() => void onDelete(k.id)}
                              >
                                {busy ? (
                                  <Loader2Icon className="size-3.5 animate-spin" aria-hidden />
                                ) : null}
                                {t("deleteKey")}
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => setConfirmDeleteId(null)}
                              >
                                {t("cancel")}
                              </Button>
                            </div>
                          </AlertDescription>
                        </Alert>
                      </MotionCollapse>
                      <MotionCollapse open={isEditing && editDraft !== null}>
                        {isEditing && editDraft ? (
                          <FieldGroup
                            // `@lg/gateway-pane`, not `sm:` — this sits inside the
                            // detail pane, which is a fraction of the window, so a
                            // viewport breakpoint would split it into two columns
                            // while the pane itself is still narrow.
                            className="mt-2 grid gap-3 border-t pt-3 @lg/gateway-pane:grid-cols-2"
                            data-testid={`gateway-key-edit-${k.id}`}
                          >
                            <KeyFormFields
                              idPrefix={`edit-${k.id}`}
                              draft={editDraft}
                              nameError={editNameError}
                              onChange={(patch) => {
                                setEditDraft({ ...editDraft, ...patch })
                                if (patch.name !== undefined) setEditNameError(false)
                              }}
                            />
                            <Field className="@lg/gateway-pane:col-span-2">
                              <FieldLabel>{t("keyScopes")}</FieldLabel>
                              <div
                                className="flex flex-wrap gap-x-4 gap-y-2"
                                data-testid={`gateway-key-scopes-${k.id}`}
                              >
                                {GATEWAY_RUN_API_SCOPES.map((scope) => (
                                  <label
                                    key={scope}
                                    className="flex items-center gap-2 text-xs"
                                    htmlFor={`edit-scope-${k.id}-${scope}`}
                                  >
                                    <Switch
                                      id={`edit-scope-${k.id}-${scope}`}
                                      checked={editDraft.scopes.includes(scope)}
                                      onCheckedChange={(on) =>
                                        setEditDraft({
                                          ...editDraft,
                                          scopes: on
                                            ? [...editDraft.scopes, scope]
                                            : editDraft.scopes.filter((held) => held !== scope),
                                        })
                                      }
                                      aria-label={scope}
                                    />
                                    <span className="font-mono">{scope}</span>
                                  </label>
                                ))}
                              </div>
                              <FieldDescription>{t("keyScopesHelp")}</FieldDescription>
                            </Field>
                            <div className="flex flex-wrap items-center gap-2 @lg/gateway-pane:col-span-2">
                              <Button
                                size="sm"
                                disabled={busy}
                                onClick={() => void onSaveEdit(k.id)}
                              >
                                {busy ? (
                                  <Loader2Icon className="size-3.5 animate-spin" aria-hidden />
                                ) : null}
                                {t("save")}
                              </Button>
                              <Button size="sm" variant="ghost" onClick={closeEdit}>
                                {t("cancel")}
                              </Button>
                            </div>
                          </FieldGroup>
                        ) : null}
                      </MotionCollapse>
                    </div>
                  </Item>
                </MotionReveal>
              )
            })}
          </ItemGroup>
        )}
      </GatewayPanelSection>

      <GatewayPanelSection
        icon={<PlusIcon className="size-4" />}
        title={t("createKey")}
        description={t("createKeyHelp")}
      >
        <FieldGroup className="grid gap-3 @lg/gateway-pane:grid-cols-2">
          <KeyFormFields
            idPrefix="gw-key"
            draft={draft}
            nameError={nameError}
            placeholders
            onChange={(patch) => {
              setDraft((current) => ({ ...current, ...patch }))
              if (patch.name !== undefined) setNameError(false)
            }}
          />
          <div className="@lg/gateway-pane:col-span-2">
            <Button size="sm" disabled={creating || accountLocked} onClick={() => void onCreate()}>
              {creating ? (
                <Loader2Icon className="size-4 animate-spin" aria-hidden />
              ) : (
                <PlusIcon className="size-4" aria-hidden />
              )}
              {t("createKey")}
            </Button>
          </div>
        </FieldGroup>
      </GatewayPanelSection>
    </GatewayPanelStack>
  )
}

function KeyMeta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 gap-1.5">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate">{children}</dd>
    </div>
  )
}

/**
 * The five fields a key is created with and edited through. One component for
 * both forms: they had drifted into two hand-copied blocks, and only the edit
 * copy had lost its help text.
 */
function KeyFormFields({
  idPrefix,
  draft,
  nameError,
  placeholders = false,
  onChange,
}: {
  idPrefix: string
  draft: KeyDraft
  nameError: boolean
  /** Example values in the empty create form; the edit form holds real ones. */
  placeholders?: boolean
  onChange: (patch: Partial<KeyDraft>) => void
}) {
  const t = useTranslations("settings.gateway")
  const nameErrorId = `${idPrefix}-name-error`

  return (
    <>
      <Field data-invalid={nameError || undefined}>
        <FieldLabel htmlFor={`${idPrefix}-name`}>{t("keyName")}</FieldLabel>
        <Input
          id={`${idPrefix}-name`}
          value={draft.name}
          placeholder={placeholders ? t("keyNamePlaceholder") : undefined}
          aria-invalid={nameError}
          aria-describedby={nameError ? nameErrorId : undefined}
          onChange={(e) => onChange({ name: e.target.value })}
        />
        {nameError ? <FieldError id={nameErrorId}>{t("keyNameRequired")}</FieldError> : null}
      </Field>
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-models`}>{t("keyModels")}</FieldLabel>
        <Input
          id={`${idPrefix}-models`}
          value={draft.models}
          placeholder={t("keyModelsPlaceholder")}
          onChange={(e) => onChange({ models: e.target.value })}
        />
        <FieldDescription>{t("keyModelsHelp")}</FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-expiry`}>{t("keyExpiry")}</FieldLabel>
        <Input
          id={`${idPrefix}-expiry`}
          type="date"
          value={draft.expiry}
          onChange={(e) => onChange({ expiry: e.target.value })}
        />
        <FieldDescription>{t("keyExpiryHelp")}</FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-rate`}>{t("keyRateLimit")}</FieldLabel>
        <Input
          id={`${idPrefix}-rate`}
          type="number"
          min={1}
          value={draft.rate}
          placeholder={t("keyRateLimitNone")}
          onChange={(e) => onChange({ rate: e.target.value })}
        />
        <FieldDescription>{t("keyRateLimitHelp")}</FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-quota`}>{t("keyQuota")}</FieldLabel>
        <Input
          id={`${idPrefix}-quota`}
          type="number"
          min={1}
          value={draft.quota}
          placeholder={t("keyQuotaNone")}
          onChange={(e) => onChange({ quota: e.target.value })}
        />
        <FieldDescription>{t("keyQuotaHelp")}</FieldDescription>
      </Field>
    </>
  )
}
