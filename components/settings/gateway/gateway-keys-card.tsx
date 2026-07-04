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
  CopyIcon,
  EyeIcon,
  KeyRoundIcon,
  PencilIcon,
  PlusIcon,
  RotateCcwIcon,
  Trash2Icon,
} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  gatewayCreateKey,
  gatewayDeleteKey,
  gatewayListKeys,
  gatewayResetKeyQuota,
  gatewayRevealKey,
  gatewayUpdateKey,
} from "@/lib/tauri/gateway"
import type { GatewayApiKey, GatewayApiKeyRedacted } from "@/types/gateway"

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

  const copyFresh = async () => {
    if (!freshKey) return
    await navigator.clipboard.writeText(freshKey.secret).catch(() => {})
    toast.success(t("keyCopied"))
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <KeyRoundIcon className="h-4 w-4" />
          {t("keysHeading")}
        </CardTitle>
        <CardDescription>{t("keysHelp")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {freshKey && (
          <div
            className="space-y-2 rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3"
            data-testid="gateway-fresh-key"
          >
            <p className="text-xs font-medium">{t("newKeyHeading")}</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-xs">
                {freshKey.secret}
              </code>
              <Button size="sm" variant="outline" onClick={copyFresh}>
                <CopyIcon className="mr-1.5 h-3.5 w-3.5" />
                {t("copyKey")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setFreshKey(null)}>
                {t("hide")}
              </Button>
            </div>
            <p className="text-xs text-amber-600 dark:text-amber-400">{t("newKeyReveal")}</p>
          </div>
        )}

        {/* Key list */}
        {keys.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("keysEmpty")}</p>
        ) : (
          <ul className="space-y-2" data-testid="gateway-keys">
            {keys.map((k) => {
              const expired = k.expiresAtMs != null && k.expiresAtMs <= now
              const overQuota = k.quotaTokens != null && k.quotaUsedTokens >= k.quotaTokens
              const isEditing = editId === k.id
              return (
                <li key={k.id} className="rounded-md border p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">{k.name}</span>
                        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                          {k.secretPreview}
                        </code>
                        {expired && <Badge variant="destructive">{t("keyExpired")}</Badge>}
                        {overQuota && <Badge variant="destructive">{t("quotaExceeded")}</Badge>}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
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
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5">
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
                      {confirmDeleteId === k.id ? (
                        <Button size="sm" variant="destructive" onClick={() => void onDelete(k.id)}>
                          {t("deleteKey")}
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setConfirmDeleteId(k.id)}
                          aria-label={`${t("deleteKey")} ${k.name}`}
                        >
                          <Trash2Icon className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  </div>
                  {confirmDeleteId === k.id && (
                    <p className="mt-2 text-xs text-destructive">{t("deleteKeyConfirm")}</p>
                  )}
                  {isEditing && editDraft && (
                    <div
                      className="mt-3 grid gap-2 rounded-md border border-dashed p-3 sm:grid-cols-2"
                      data-testid={`gateway-key-edit-${k.id}`}
                    >
                      <div className="space-y-1">
                        <Label htmlFor={`edit-name-${k.id}`} className="text-xs">
                          {t("keyName")}
                        </Label>
                        <Input
                          id={`edit-name-${k.id}`}
                          value={editDraft.name}
                          onChange={(e) => setEditDraft({ ...editDraft, name: e.target.value })}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor={`edit-models-${k.id}`} className="text-xs">
                          {t("keyModels")}
                        </Label>
                        <Input
                          id={`edit-models-${k.id}`}
                          value={editDraft.models}
                          placeholder={t("keyModelsPlaceholder")}
                          onChange={(e) => setEditDraft({ ...editDraft, models: e.target.value })}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor={`edit-expiry-${k.id}`} className="text-xs">
                          {t("keyExpiry")}
                        </Label>
                        <Input
                          id={`edit-expiry-${k.id}`}
                          type="date"
                          value={editDraft.expiry}
                          onChange={(e) => setEditDraft({ ...editDraft, expiry: e.target.value })}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor={`edit-rate-${k.id}`} className="text-xs">
                          {t("keyRateLimit")}
                        </Label>
                        <Input
                          id={`edit-rate-${k.id}`}
                          type="number"
                          min={1}
                          value={editDraft.rate}
                          placeholder={t("keyRateLimitNone")}
                          onChange={(e) => setEditDraft({ ...editDraft, rate: e.target.value })}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor={`edit-quota-${k.id}`} className="text-xs">
                          {t("keyQuota")}
                        </Label>
                        <Input
                          id={`edit-quota-${k.id}`}
                          type="number"
                          min={1}
                          value={editDraft.quota}
                          placeholder={t("keyQuotaNone")}
                          onChange={(e) => setEditDraft({ ...editDraft, quota: e.target.value })}
                        />
                        <p className="text-[10px] text-muted-foreground">{t("keyQuotaHelp")}</p>
                      </div>
                      <div className="flex items-center gap-2 sm:col-span-2">
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
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}

        {/* Create form */}
        <div className="grid gap-2 rounded-md border border-dashed p-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="gw-key-name" className="text-xs">
              {t("keyName")}
            </Label>
            <Input
              id="gw-key-name"
              value={name}
              placeholder={t("keyNamePlaceholder")}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="gw-key-models" className="text-xs">
              {t("keyModels")}
            </Label>
            <Input
              id="gw-key-models"
              value={models}
              placeholder={t("keyModelsPlaceholder")}
              onChange={(e) => setModels(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="gw-key-expiry" className="text-xs">
              {t("keyExpiry")}
            </Label>
            <Input
              id="gw-key-expiry"
              type="date"
              value={expiry}
              onChange={(e) => setExpiry(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="gw-key-rate" className="text-xs">
              {t("keyRateLimit")}
            </Label>
            <Input
              id="gw-key-rate"
              type="number"
              min={1}
              value={rate}
              placeholder={t("keyRateLimitNone")}
              onChange={(e) => setRate(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="gw-key-quota" className="text-xs">
              {t("keyQuota")}
            </Label>
            <Input
              id="gw-key-quota"
              type="number"
              min={1}
              value={quota}
              placeholder={t("keyQuotaNone")}
              onChange={(e) => setQuota(e.target.value)}
            />
            <p className="text-[10px] text-muted-foreground">{t("keyQuotaHelp")}</p>
          </div>
          <div className="sm:col-span-2">
            <Button size="sm" onClick={() => void onCreate()}>
              <PlusIcon className="mr-1.5 h-4 w-4" />
              {t("createKey")}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

export default GatewayKeysCard
