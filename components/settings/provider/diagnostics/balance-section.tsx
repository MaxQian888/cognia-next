"use client"

import { useState } from "react"
import { Coins, RefreshCw, Trash2 } from "lucide-react"
import { useTranslations } from "next-intl"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { ProviderSection } from "../provider-section"
import type { ResolvedProviderBalanceSource } from "@/lib/provider-diagnostics/balance"
import type { ProviderBalanceSnapshot } from "@cognia/provider-types"

/** A user-authored balance script, as submitted from the form below. */
export interface BalanceScriptDraft {
  label: string
  origin: string
  token: string
  code: string
  grantDomain: string
  allowHttp: boolean
  allowPrivate: boolean
}

export interface BalanceSectionProps {
  sources: ResolvedProviderBalanceSource[]
  snapshots: ProviderBalanceSnapshot[]
  /** Per-source low-balance alarm, keyed by source id. */
  thresholds: Record<string, { unit: string; value: number } | undefined>
  /** Default origin for a new script — the provider's current base URL. */
  defaultOrigin: string
  onRefresh: (source: ResolvedProviderBalanceSource) => void
  onMakePrimary: (sourceId: string) => void
  onThresholdChange: (sourceId: string, unit: string, value: number) => void
  onRemoveSource: (sourceId: string) => void
  /** Resolves once the draft is persisted; rejects with a message to display. */
  onSaveScript: (draft: BalanceScriptDraft) => Promise<void>
  /** A paired client mirrors the desktop's balances and cannot edit them. */
  readOnly?: boolean
}

/**
 * Remaining credit per balance source, plus the sandboxed-script editor for
 * providers with no official balance API.
 *
 * The script token is never held in settings: `onSaveScript` hands it to the
 * keyring and stores only a reference, so this form clears its own token field
 * as soon as the save resolves.
 */
export function BalanceSection({
  sources,
  snapshots,
  thresholds,
  defaultOrigin,
  onRefresh,
  onMakePrimary,
  onThresholdChange,
  onRemoveSource,
  onSaveScript,
  readOnly = false,
}: BalanceSectionProps) {
  const t = useTranslations("providers.diagnostics")
  const [label, setLabel] = useState("")
  const [origin, setOrigin] = useState(defaultOrigin)
  const [token, setToken] = useState("")
  const [code, setCode] = useState("")
  const [grantDomain, setGrantDomain] = useState("")
  const [allowHttp, setAllowHttp] = useState(false)
  const [allowPrivate, setAllowPrivate] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    setError(null)
    try {
      await onSaveScript({ label, origin, token, code, grantDomain, allowHttp, allowPrivate })
      setLabel("")
      setToken("")
      setCode("")
      setGrantDomain("")
      setAllowHttp(false)
      setAllowPrivate(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <ProviderSection
      collapsible
      icon={Coins}
      title={t("balance.title")}
      description={t("balance.description")}
      contentClassName="space-y-3"
      data-testid="diagnostics-balance"
    >
      {sources.map((source) => {
        const snapshot = snapshots.find((item) => item.sourceId === source.id)
        const threshold = thresholds[source.id]
        const thresholdUnit =
          threshold?.unit ?? snapshot?.amounts[0]?.unit ?? source.unit ?? "credits"
        return (
          <div key={source.id} className="rounded-lg border p-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{source.label}</p>
                <p className="text-xs text-muted-foreground">
                  {t(`balance.kind.${source.kind}` as never)}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {source.primary && <Badge>{t("balance.primary")}</Badge>}
                {source.kind === "sandbox-script" && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={readOnly}
                    aria-label={t("balance.removeSource")}
                    onClick={() => onRemoveSource(source.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              {snapshot?.amounts.map((amount) => (
                <Badge key={amount.unit} variant="outline">
                  {amount.remaining ?? "—"} {amount.unit}
                </Badge>
              )) ?? (
                <span className="text-xs text-muted-foreground">{t("balance.noSnapshot")}</span>
              )}
            </div>
            {snapshot?.failure && (
              <p className="mt-2 text-xs text-destructive">{snapshot.failure.message}</p>
            )}

            <div className="mt-3 grid grid-cols-[1fr_auto] items-end gap-2">
              <div className="space-y-1">
                <Label htmlFor={`balance-threshold-${source.id}`} className="text-xs">
                  {t("balance.threshold", { unit: thresholdUnit })}
                </Label>
                <Input
                  id={`balance-threshold-${source.id}`}
                  type="number"
                  min={0}
                  value={threshold?.value ?? ""}
                  placeholder={t("balance.thresholdPlaceholder")}
                  disabled={readOnly}
                  onChange={(event) =>
                    onThresholdChange(source.id, thresholdUnit, Number(event.target.value))
                  }
                />
              </div>
              <div className="flex gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onRefresh(source)}
                  disabled={
                    readOnly ||
                    source.kind === "unsupported" ||
                    (!source.query && !source.scriptConfig)
                  }
                >
                  <RefreshCw className="mr-1 h-3.5 w-3.5" />
                  {t("balance.refresh")}
                </Button>
                {!source.primary && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={readOnly}
                    onClick={() => onMakePrimary(source.id)}
                  >
                    {t("balance.makePrimary")}
                  </Button>
                )}
              </div>
            </div>

            {/* Provenance, folded away: which credential produced this number and
                when. It is the first thing asked when a balance looks wrong. */}
            <details className="mt-3 text-xs">
              <summary className="cursor-pointer text-muted-foreground">
                {t("balance.audit")}
              </summary>
              <dl className="mt-2 grid gap-1 rounded bg-muted/30 p-2">
                <div>
                  <dt className="inline text-muted-foreground">{t("balance.sourceId")}: </dt>
                  <dd className="inline break-all">{source.id}</dd>
                </div>
                <div>
                  <dt className="inline text-muted-foreground">{t("balance.credential")}: </dt>
                  <dd className="inline break-all">{source.credentialFingerprint}</dd>
                </div>
                <div>
                  <dt className="inline text-muted-foreground">{t("balance.fetchedAt")}: </dt>
                  <dd className="inline">
                    {snapshot ? new Date(snapshot.fetchedAt).toLocaleString() : "—"}
                  </dd>
                </div>
                {source.scriptConfig?.grants.map((grant) => (
                  <div key={grant.domain}>
                    <dt className="inline text-muted-foreground">{t("balance.grant")}: </dt>
                    <dd className="inline">
                      {grant.domain} ·{" "}
                      {t("balance.grantPolicy", {
                        https: t("balance.policyHttps"),
                        http: grant.allowHttp ? t("balance.policyHttp") : "",
                        private: grant.allowPrivate ? t("balance.policyPrivate") : "",
                      })}
                    </dd>
                  </div>
                ))}
              </dl>
            </details>
          </div>
        )
      })}

      <details className="rounded-lg border p-3">
        <summary className="cursor-pointer text-sm font-medium">{t("balance.addScript")}</summary>
        <div className="mt-3 grid gap-3">
          <div className="grid gap-3 @md/diagnostics:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="balance-script-label">{t("balance.scriptLabel")}</Label>
              <Input
                id="balance-script-label"
                value={label}
                disabled={readOnly}
                onChange={(event) => setLabel(event.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="balance-script-origin">{t("balance.scriptOrigin")}</Label>
              <Input
                id="balance-script-origin"
                value={origin}
                disabled={readOnly}
                onChange={(event) => setOrigin(event.target.value)}
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="balance-script-token">{t("balance.scriptToken")}</Label>
            <Input
              id="balance-script-token"
              type="password"
              value={token}
              disabled={readOnly}
              onChange={(event) => setToken(event.target.value)}
              autoComplete="off"
            />
            <p className="text-xs text-muted-foreground">{t("balance.scriptTokenHint")}</p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="balance-script-code">{t("balance.scriptCode")}</Label>
            <Textarea
              id="balance-script-code"
              className="min-h-40 font-mono text-xs"
              value={code}
              disabled={readOnly}
              onChange={(event) => setCode(event.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="balance-script-domain">{t("balance.grantDomain")}</Label>
            <Input
              id="balance-script-domain"
              value={grantDomain}
              disabled={readOnly}
              onChange={(event) => setGrantDomain(event.target.value)}
              placeholder={t("balance.grantOptional")}
            />
          </div>
          <div className="flex flex-wrap gap-4">
            <label className="flex items-center gap-2 text-xs">
              <Switch checked={allowHttp} disabled={readOnly} onCheckedChange={setAllowHttp} />
              {t("balance.allowHttp")}
            </label>
            <label className="flex items-center gap-2 text-xs">
              <Switch
                checked={allowPrivate}
                disabled={readOnly}
                onCheckedChange={setAllowPrivate}
              />
              {t("balance.allowPrivate")}
            </label>
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <Button disabled={readOnly} onClick={() => void submit()}>
            {t("balance.saveScript")}
          </Button>
        </div>
      </details>
    </ProviderSection>
  )
}
