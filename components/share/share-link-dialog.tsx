"use client"

// Reusable "Share via link" dialog. Given a `buildPayload` thunk (so the
// artifact is only rendered when the user commits), it creates a zero-knowledge
// share link and shows the URL with copy / QR / revoke. Used by chat export,
// workflow export, backup, and A2UI share entry points.

import { useState } from "react"
import { useTranslations } from "next-intl"
import { QRCodeSVG } from "qrcode.react"
import { CheckIcon, CopyIcon, ExternalLinkIcon, Link2Icon, ShieldOffIcon } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import {
  createShareLink,
  revokeShareLink,
  ShareNotConfiguredError,
  SharePayloadTooLargeError,
  ShareRequestError,
} from "@/lib/share/client"
import type { SharePayload } from "@/lib/share/types"
import type { CreatedShare } from "@/lib/share/client"
import { PayloadView } from "@/components/share/payload-view"
import { createLogger } from "@cognia/logging"

const log = createLogger("share-link")

type TtlOption = "never" | "1h" | "24h" | "7d"
const TTL_SECONDS: Record<TtlOption, number | undefined> = {
  never: undefined,
  "1h": 3600,
  "24h": 86_400,
  "7d": 604_800,
}
type LimitMode = "unlimited" | "count" | "burn"

interface Props {
  buildPayload: () => SharePayload | Promise<SharePayload>
  trigger?: React.ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** Invoked when the user clicks the "open settings" CTA in the unconfigured state. */
  onConfigure?: () => void
}

export function ShareLinkDialog({ buildPayload, trigger, open, onOpenChange, onConfigure }: Props) {
  const t = useTranslations("share")
  const [ttl, setTtl] = useState<TtlOption>("7d")
  const [limitMode, setLimitMode] = useState<LimitMode>("unlimited")
  const [maxViews, setMaxViews] = useState(5)
  const [passphrase, setPassphrase] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notConfigured, setNotConfigured] = useState(false)
  const [created, setCreated] = useState<CreatedShare | null>(null)
  const [copied, setCopied] = useState(false)
  const [revoking, setRevoking] = useState(false)
  const [revoked, setRevoked] = useState(false)
  const [preview, setPreview] = useState<SharePayload | null>(null)

  const reset = () => {
    setCreated(null)
    setError(null)
    setNotConfigured(false)
    setCopied(false)
    setRevoked(false)
    setPassphrase("")
    setPreview(null)
  }

  // Build the payload and render it locally — no server round-trip — so the
  // owner can see exactly what recipients will get before publishing.
  const onPreview = async () => {
    setError(null)
    try {
      setPreview(await buildPayload())
    } catch (err) {
      log.error("share-preview-failed", {
        error: err instanceof Error ? err.message : String(err),
      })
      setError(t("errorGeneric"))
    }
  }

  const handleOpenChange = (next: boolean) => {
    if (!next) reset()
    onOpenChange?.(next)
  }

  const onCreate = async () => {
    setBusy(true)
    setError(null)
    setNotConfigured(false)
    try {
      const payload = await buildPayload()
      const result = await createShareLink({
        payload,
        ttlSeconds: TTL_SECONDS[ttl],
        maxViews: limitMode === "count" ? maxViews : undefined,
        burnAfterRead: limitMode === "burn",
        passphrase: passphrase || undefined,
      })
      setCreated(result)
    } catch (err) {
      if (err instanceof ShareNotConfiguredError) {
        setNotConfigured(true)
      } else if (
        err instanceof SharePayloadTooLargeError ||
        (err instanceof ShareRequestError && err.status === 413)
      ) {
        setError(t("errorTooLarge"))
      } else {
        log.error("share-create-failed", {
          error: err instanceof Error ? err.message : String(err),
        })
        setError(t("errorGeneric"))
      }
    } finally {
      setBusy(false)
    }
  }

  const onCopy = async () => {
    if (!created) return
    await navigator.clipboard.writeText(created.url)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const onRevoke = async () => {
    if (!created) return
    setRevoking(true)
    try {
      await revokeShareLink(created.code)
      setRevoked(true)
    } catch (err) {
      log.error("share-revoke-failed", { error: err instanceof Error ? err.message : String(err) })
      setError(t("errorGeneric"))
    } finally {
      setRevoking(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Link2Icon className="size-4" />
            {t("dialogTitle")}
          </DialogTitle>
          <DialogDescription>{t("dialogDescription")}</DialogDescription>
        </DialogHeader>

        {notConfigured ? (
          <div className="space-y-3 py-2 text-center">
            <ShieldOffIcon className="mx-auto size-8 text-muted-foreground" />
            <p className="font-medium">{t("notConfiguredTitle")}</p>
            <p className="text-sm text-muted-foreground">{t("notConfiguredBody")}</p>
            {onConfigure && (
              <Button variant="outline" onClick={onConfigure}>
                {t("notConfiguredCta")}
              </Button>
            )}
          </div>
        ) : created ? (
          <div className="space-y-4 py-2">
            <p className="text-sm font-medium">{t("createdTitle")}</p>
            <div className="flex gap-2">
              <Input
                readOnly
                value={created.url}
                aria-label={t("linkLabel")}
                className="font-mono text-xs"
              />
              <Button
                variant="outline"
                size="icon"
                aria-label={t("copy")}
                onClick={() => void onCopy()}
              >
                {copied ? <CheckIcon className="size-4" /> : <CopyIcon className="size-4" />}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t("createdHelp")}</p>
            <div className="flex flex-col items-center gap-1">
              <QRCodeSVG value={created.url} size={160} level="M" aria-label={t("scanHint")} />
              <span className="text-xs text-muted-foreground">{t("scanHint")}</span>
            </div>
            {revoked && <p className="text-center text-sm text-muted-foreground">{t("revoked")}</p>}
          </div>
        ) : preview ? (
          <div className="space-y-2 py-2">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">{t("view.previewTitle")}</p>
              <Button variant="ghost" size="sm" onClick={() => setPreview(null)}>
                {t("view.previewClose")}
              </Button>
            </div>
            <div className="max-h-[50vh] overflow-auto rounded-md border border-border p-3">
              <PayloadView payload={preview} />
            </div>
          </div>
        ) : (
          <div className="space-y-4 py-2">
            <div className="space-y-1">
              <Label className="text-xs">{t("ttlLabel")}</Label>
              <Select value={ttl} onValueChange={(v) => setTtl(v as TtlOption)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="never">{t("ttl.never")}</SelectItem>
                  <SelectItem value="1h">{t("ttl.h1")}</SelectItem>
                  <SelectItem value="24h">{t("ttl.h24")}</SelectItem>
                  <SelectItem value="7d">{t("ttl.d7")}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <Label className="text-xs">{t("limitLabel")}</Label>
              <Select value={limitMode} onValueChange={(v) => setLimitMode(v as LimitMode)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="unlimited">{t("limit.unlimited")}</SelectItem>
                  <SelectItem value="count">{t("limit.count")}</SelectItem>
                  <SelectItem value="burn">{t("limit.burn")}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {limitMode === "count" && (
              <div className="space-y-1">
                <Label className="text-xs">{t("maxViewsLabel")}</Label>
                <Input
                  type="number"
                  min={1}
                  value={maxViews}
                  onChange={(e) => setMaxViews(Math.max(1, Number(e.target.value) || 1))}
                />
              </div>
            )}

            <div className="space-y-1">
              <Label className="text-xs">{t("passphraseLabel")}</Label>
              <Input
                type="password"
                value={passphrase}
                placeholder={t("passphrasePlaceholder")}
                onChange={(e) => setPassphrase(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">{t("passphraseHelp")}</p>
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        )}

        <DialogFooter>
          {created ? (
            <>
              <Button
                variant="ghost"
                onClick={() => void onRevoke()}
                disabled={revoking || revoked}
              >
                {revoking ? t("revoking") : t("revoke")}
              </Button>
              <Button asChild variant="outline">
                <a href={created.url} target="_blank" rel="noreferrer">
                  <ExternalLinkIcon className="mr-1.5 size-4" />
                  {t("openLink")}
                </a>
              </Button>
              <Button onClick={() => handleOpenChange(false)}>{t("done")}</Button>
            </>
          ) : notConfigured ? null : (
            <>
              {!preview && (
                <Button variant="outline" onClick={() => void onPreview()} disabled={busy}>
                  {t("view.preview")}
                </Button>
              )}
              <Button onClick={() => void onCreate()} disabled={busy}>
                {busy ? t("creating") : t("createButton")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
