"use client"

/**
 * Gateway API keys manager (desktop only).
 *
 * Issues, scopes, edits, toggles, reveals, and deletes the keyring-backed API
 * keys the inbound gateway authenticates against — the newapi "Tokens"
 * equivalent. Each key carries an optional model allowlist, expiry, per-minute
 * rate limit, and a cumulative token quota (drawn down per request; the gateway
 * rejects a key that has spent its budget). A freshly created key's secret is
 * shown exactly once (create returns the full value; every list afterwards is
 * redacted to a fingerprint).
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import {
  EyeIcon,
  KeyRoundIcon,
  PencilIcon,
  PlusIcon,
  RotateCcwIcon,
  Trash2Icon,
} from "lucide-react"
import { toast } from "sonner"

import { Snippet, SnippetCopyButton, SnippetInput } from "@/components/ai-elements/snippet"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/components/ui/item"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { MotionCollapse, MotionReveal } from "@/components/chat/motion/motion-reveal"
import { SettingsEmptyState } from "@/components/settings/common/settings-section"
import {
  gatewayCreateKey,
  gatewayDeleteKey,
  gatewayListKeys,
  gatewayResetKeyQuota,
  gatewayRevealKey,
  gatewayUpdateKey,
} from "@/lib/tauri/gateway"
import type { GatewayApiKey, GatewayApiKeyRedacted } from "@/types/gateway"

import { GatewayPanelSection, GatewayPanelStack } from "./shared/panel-section"

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

interface EditDraft {
  name: string
  models: string
  expiry: string
  rate: string
  quota: string
}

export function GatewayKeysCard({ onChanged }: { onChanged?: () => void }) {
  const t = useTranslations("settings.gateway")
  const [keys, setKeys] = useState<GatewayApiKeyRedacted[]>([])
  // Snapshot of "now" captured whenever keys (re)load — used to flag expired
  // keys without calling Date.now() during render (react-hooks/purity).
  const [now, setNow] = useState(0)
  const [freshKey, setFreshKey] = useState<GatewayApiKey | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [editId, setEditId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null)

  const [name, setName] = useState("")
  const [models, setModels] = useState("")
  const [expiry, setExpiry] = useState("")
  const [rate, setRate] = useState("")
  const [quota, setQuota] = useState("")

  const refresh = () =>
    gatewayListKeys()
      .then((k) => {
        setKeys(k)
        setNow(Date.now())
      })
      .catch(() => {})

  useEffect(() => {
    // setState in the promise callback — an external-system update, not a
    // synchronous effect-body write (react-hooks/set-state-in-effect).
    gatewayListKeys()
      .then((k) => {
        setKeys(k)
        setNow(Date.now())
      })
      .catch(() => {})
  }, [])

  const onCreate = async () => {
    if (!name.trim()) {
      toast.error(t("keyName"))
      return
    }
    try {
      const created = await gatewayCreateKey({
        name: name.trim(),
        modelAllowlist: parseCsv(models),
        expiresAtMs: parseExpiry(expiry),
        rateLimitPerMin: parsePositiveInt(rate),
        quotaTokens: parsePositiveInt(quota),
      })
      setFreshKey(created)
      setName("")
      setModels("")
      setExpiry("")
      setRate("")
      setQuota("")
      await refresh()
      onChanged?.()
    } catch (e) {
      toast.error(errMsg(e))
    }
  }

  const onToggle = async (id: string, enabled: boolean) => {
    try {
      await gatewayUpdateKey(id, { enabled })
      await refresh()
      onChanged?.()
    } catch (e) {
      toast.error(errMsg(e))
    }
  }

  const startEdit = (k: GatewayApiKeyRedacted) => {
    setConfirmDeleteId(null)
    setEditId(k.id)
    setEditDraft({
      name: k.name,
      models: k.modelAllowlist.join(", "),
      expiry: toDateInput(k.expiresAtMs),
      rate: k.rateLimitPerMin != null ? String(k.rateLimitPerMin) : "",
      quota: k.quotaTokens != null ? String(k.quotaTokens) : "",
    })
  }

  const onSaveEdit = async (id: string) => {
    if (!editDraft) return
    if (!editDraft.name.trim()) {
      toast.error(t("keyName"))
      return
    }
    try {
      await gatewayUpdateKey(id, {
        name: editDraft.name.trim(),
        modelAllowlist: parseCsv(editDraft.models),
        // `null` explicitly clears the optional value.
        expiresAtMs: parseExpiry(editDraft.expiry),
        rateLimitPerMin: parsePositiveInt(editDraft.rate),
        quotaTokens: parsePositiveInt(editDraft.quota),
      })
      setEditId(null)
      setEditDraft(null)
      await refresh()
      onChanged?.()
      toast.success(t("saved"))
    } catch (e) {
      toast.error(errMsg(e))
    }
  }

  const onResetQuota = async (id: string) => {
    try {
      await gatewayResetKeyQuota(id)
      await refresh()
      toast.success(t("quotaReset"))
    } catch (e) {
      toast.error(errMsg(e))
    }
  }

  const onDelete = async (id: string) => {
    try {
      await gatewayDeleteKey(id)
      setConfirmDeleteId(null)
      await refresh()
      onChanged?.()
    } catch (e) {
      toast.error(errMsg(e))
    }
  }

  const onReveal = async (id: string) => {
    try {
      const secret = await gatewayRevealKey(id)
      if (!secret) return
      await navigator.clipboard.writeText(secret).catch(() => {})
      toast.success(t("keyCopied"))
    } catch (e) {
      toast.error(errMsg(e))
    }
  }

  return (
    <GatewayPanelStack>
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
                      onError={(error) => toast.error(error.message)}
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

        {/* Key list */}
        {keys.length === 0 ? (
          <SettingsEmptyState
            icon={<KeyRoundIcon className="size-5" />}
            title={t("keysEmpty")}
            className="py-6"
          />
        ) : (
          <ItemGroup className="gap-2" data-testid="gateway-keys">
            {keys.map((k, index) => {
              const expired = k.expiresAtMs != null && k.expiresAtMs <= now
              const overQuota = k.quotaTokens != null && k.quotaUsedTokens >= k.quotaTokens
              const isEditing = editId === k.id
              return (
                <MotionReveal key={k.id} index={index}>
                  <Item role="listitem" variant="muted" className="items-start">
                    <ItemContent className="min-w-0">
                      <ItemTitle className="w-full min-w-0 flex-wrap">
                        <span className="truncate">{k.name}</span>
                        <Badge
                          variant="outline"
                          className="max-w-full truncate font-mono text-[10px] font-normal"
                        >
                          {k.secretPreview}
                        </Badge>
                        {expired && <Badge variant="destructive">{t("keyExpired")}</Badge>}
                        {overQuota && <Badge variant="destructive">{t("quotaExceeded")}</Badge>}
                      </ItemTitle>
                      <ItemDescription className="flex max-w-full flex-wrap items-center gap-1.5 text-[11px]">
                        <span>
                          {k.modelAllowlist.length === 0
                            ? t("keyModelsAll")
                            : k.modelAllowlist.join(", ")}
                        </span>
                        <span>·</span>
                        <span>
                          {t("keyExpiry")}:{" "}
                          {k.expiresAtMs
                            ? new Date(k.expiresAtMs).toLocaleDateString()
                            : t("keyNeverExpires")}
                        </span>
                        <span>·</span>
                        <span>
                          {t("keyRateLimit")}: {k.rateLimitPerMin ?? t("keyRateLimitNone")}
                        </span>
                        <span>·</span>
                        <span>
                          {t("keyQuota")}:{" "}
                          {k.quotaTokens != null
                            ? t("keyQuotaUsed", {
                                used: k.quotaUsedTokens.toLocaleString(),
                                total: k.quotaTokens.toLocaleString(),
                              })
                            : t("keyQuotaNone")}
                        </span>
                        <span>·</span>
                        <span>
                          {k.lastUsedAtMs
                            ? `${t("keyLastUsed")}: ${new Date(k.lastUsedAtMs).toLocaleString()}`
                            : t("keyNeverUsed")}
                        </span>
                      </ItemDescription>
                    </ItemContent>
                    <ItemActions className="max-w-full flex-wrap justify-end">
                      <Switch
                        checked={k.enabled}
                        onCheckedChange={(v) => void onToggle(k.id, v)}
                        aria-label={`${k.enabled ? t("disable") : t("enable")} ${k.name}`}
                      />
                      {k.quotaTokens != null && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => void onResetQuota(k.id)}
                          aria-label={`${t("resetQuota")} ${k.name}`}
                          title={t("resetQuota")}
                        >
                          <RotateCcwIcon className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => (isEditing ? setEditId(null) : startEdit(k))}
                        aria-label={`${t("editKey")} ${k.name}`}
                      >
                        <PencilIcon className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void onReveal(k.id)}
                        aria-label={`${t("reveal")} ${k.name}`}
                      >
                        <EyeIcon className="h-3.5 w-3.5" />
                      </Button>
                      {/* The trigger stays put whether or not the confirmation
                          is open. It used to be REPLACED by a wide destructive
                          button, so asking to delete visibly re-flowed the row
                          and moved every other control under the cursor. */}
                      <Button
                        size="sm"
                        variant={confirmDeleteId === k.id ? "secondary" : "ghost"}
                        onClick={() => setConfirmDeleteId((cur) => (cur === k.id ? null : k.id))}
                        aria-label={`${t("deleteKey")} ${k.name}`}
                        aria-expanded={confirmDeleteId === k.id}
                      >
                        <Trash2Icon className="h-3.5 w-3.5" />
                      </Button>
                    </ItemActions>
                    <div className="w-full basis-full">
                      <MotionCollapse open={confirmDeleteId === k.id}>
                        <Alert variant="destructive" className="mt-2">
                          <AlertDescription className="flex w-full flex-col gap-2 @md/gateway-pane:flex-row @md/gateway-pane:items-center">
                            <p className="flex-1">{t("deleteKeyConfirm")}</p>
                            <div className="flex flex-wrap gap-2">
                              <Button
                                size="sm"
                                variant="destructive"
                                onClick={() => void onDelete(k.id)}
                              >
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
                            className="mt-3 grid gap-3 @lg/gateway-pane:grid-cols-2"
                            data-testid={`gateway-key-edit-${k.id}`}
                          >
                            <Field>
                              <FieldLabel htmlFor={`edit-name-${k.id}`}>{t("keyName")}</FieldLabel>
                              <Input
                                id={`edit-name-${k.id}`}
                                value={editDraft.name}
                                onChange={(e) =>
                                  setEditDraft({ ...editDraft, name: e.target.value })
                                }
                              />
                            </Field>
                            <Field>
                              <FieldLabel htmlFor={`edit-models-${k.id}`}>
                                {t("keyModels")}
                              </FieldLabel>
                              <Input
                                id={`edit-models-${k.id}`}
                                value={editDraft.models}
                                placeholder={t("keyModelsPlaceholder")}
                                onChange={(e) =>
                                  setEditDraft({ ...editDraft, models: e.target.value })
                                }
                              />
                            </Field>
                            <Field>
                              <FieldLabel htmlFor={`edit-expiry-${k.id}`}>
                                {t("keyExpiry")}
                              </FieldLabel>
                              <Input
                                id={`edit-expiry-${k.id}`}
                                type="date"
                                value={editDraft.expiry}
                                onChange={(e) =>
                                  setEditDraft({ ...editDraft, expiry: e.target.value })
                                }
                              />
                            </Field>
                            <Field>
                              <FieldLabel htmlFor={`edit-rate-${k.id}`}>
                                {t("keyRateLimit")}
                              </FieldLabel>
                              <Input
                                id={`edit-rate-${k.id}`}
                                type="number"
                                min={1}
                                value={editDraft.rate}
                                placeholder={t("keyRateLimitNone")}
                                onChange={(e) =>
                                  setEditDraft({ ...editDraft, rate: e.target.value })
                                }
                              />
                            </Field>
                            <Field>
                              <FieldLabel htmlFor={`edit-quota-${k.id}`}>
                                {t("keyQuota")}
                              </FieldLabel>
                              <Input
                                id={`edit-quota-${k.id}`}
                                type="number"
                                min={1}
                                value={editDraft.quota}
                                placeholder={t("keyQuotaNone")}
                                onChange={(e) =>
                                  setEditDraft({ ...editDraft, quota: e.target.value })
                                }
                              />
                              <FieldDescription>{t("keyQuotaHelp")}</FieldDescription>
                            </Field>
                            <div className="flex flex-wrap items-center gap-2 @lg/gateway-pane:col-span-2">
                              <Button size="sm" onClick={() => void onSaveEdit(k.id)}>
                                {t("save")}
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => {
                                  setEditId(null)
                                  setEditDraft(null)
                                }}
                              >
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

      {/* Create form */}
      <GatewayPanelSection title={t("createKey")}>
        <FieldGroup className="grid gap-3 @lg/gateway-pane:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="gw-key-name">{t("keyName")}</FieldLabel>
            <Input
              id="gw-key-name"
              value={name}
              placeholder={t("keyNamePlaceholder")}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="gw-key-models">{t("keyModels")}</FieldLabel>
            <Input
              id="gw-key-models"
              value={models}
              placeholder={t("keyModelsPlaceholder")}
              onChange={(e) => setModels(e.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="gw-key-expiry">{t("keyExpiry")}</FieldLabel>
            <Input
              id="gw-key-expiry"
              type="date"
              value={expiry}
              onChange={(e) => setExpiry(e.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="gw-key-rate">{t("keyRateLimit")}</FieldLabel>
            <Input
              id="gw-key-rate"
              type="number"
              min={1}
              value={rate}
              placeholder={t("keyRateLimitNone")}
              onChange={(e) => setRate(e.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="gw-key-quota">{t("keyQuota")}</FieldLabel>
            <Input
              id="gw-key-quota"
              type="number"
              min={1}
              value={quota}
              placeholder={t("keyQuotaNone")}
              onChange={(e) => setQuota(e.target.value)}
            />
            <FieldDescription>{t("keyQuotaHelp")}</FieldDescription>
          </Field>
          <div className="@lg/gateway-pane:col-span-2">
            <Button size="sm" onClick={() => void onCreate()}>
              <PlusIcon className="mr-1.5 h-4 w-4" />
              {t("createKey")}
            </Button>
          </div>
        </FieldGroup>
      </GatewayPanelSection>
    </GatewayPanelStack>
  )
}

export default GatewayKeysCard
