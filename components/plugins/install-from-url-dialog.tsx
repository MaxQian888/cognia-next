"use client"

/**
 * "Install from URL" dialog for signed WASM plugin bundles.
 *
 * Flow:
 *   1. user enters bundle URL + (optional) signature URL + author key
 *   2. we call `previewBundleManifest` to validate the manifest server-
 *      side without committing
 *   3. show manifest summary + author fingerprint
 *      - if publisher is already trusted: skip step 4 entirely
 *      - if first time: explicit "trust this author" checkbox
 *   4. user accepts → call `installFromUrl` → render the capability grant
 *      sheet via the imperative hook → done
 */

import { useCallback, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  KeyRoundIcon,
  Loader2Icon,
  ShieldCheckIcon,
} from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Badge } from "@/components/ui/badge"
import {
  installFromUrl,
  previewBundleManifest,
  isPublisherKeyTrusted,
  type HttpInstallResult,
} from "@/lib/plugin/package/http-installer"
import { shortFingerprint } from "@/lib/plugin/security/signature"
import { useWasmCapabilityGrant } from "./use-wasm-capability-grant"

export interface InstallFromUrlDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onInstalled?: (result: HttpInstallResult) => void
}

type Stage = "input" | "preview" | "installing" | "error"

export function InstallFromUrlDialog({
  open,
  onOpenChange,
  onInstalled,
}: InstallFromUrlDialogProps) {
  const t = useTranslations("plugins.wasmInstall.fromUrlDialog")
  const grant = useWasmCapabilityGrant()
  const [bundleUrl, setBundleUrl] = useState("")
  const [signatureUrl, setSignatureUrl] = useState("")
  const [publicKey, setPublicKey] = useState("")
  const [stage, setStage] = useState<Stage>("input")
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [preview, setPreview] = useState<HttpInstallResult | null>(null)
  const [trustAuthor, setTrustAuthor] = useState(false)
  const [publisherAlreadyTrusted, setPublisherAlreadyTrusted] = useState(false)

  const reset = useCallback(() => {
    setBundleUrl("")
    setSignatureUrl("")
    setPublicKey("")
    setStage("input")
    setErrorMessage(null)
    setPreview(null)
    setTrustAuthor(false)
    setPublisherAlreadyTrusted(false)
  }, [])

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) reset()
      onOpenChange(next)
    },
    [onOpenChange, reset]
  )

  const handlePreview = useCallback(async () => {
    setErrorMessage(null)
    try {
      setStage("installing")
      const result = await previewBundleManifest({
        bundleUrl: bundleUrl.trim(),
        signatureUrl: signatureUrl.trim() || undefined,
        expectedPublicKeyBase64: publicKey.trim() || undefined,
        requireSignature: false,
      })
      setPreview(result)
      const trusted = await isPublisherKeyTrusted(result.authorPublicKey)
      setPublisherAlreadyTrusted(trusted)
      setTrustAuthor(trusted) // already trusted → preselect "yes, keep trusting"
      setStage("preview")
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error))
      setStage("error")
    }
  }, [bundleUrl, signatureUrl, publicKey])

  const trustRequiredError = t("trustRequiredError")

  const handleConfirm = useCallback(async () => {
    if (!preview) return
    setErrorMessage(null)
    setStage("installing")
    try {
      // If the user opted not to trust an unknown signed author, abort
      // before we hit the network again — they have to accept first.
      if (preview.signatureVerified && !publisherAlreadyTrusted && !trustAuthor) {
        throw new Error(trustRequiredError)
      }
      const result = await installFromUrl({
        bundleUrl: bundleUrl.trim(),
        signatureUrl: signatureUrl.trim() || undefined,
        expectedPublicKeyBase64: publicKey.trim() || undefined,
      })
      const decision = await grant.requestGrant({
        manifest: result.manifest,
        authorFingerprint: result.authorFingerprint
          ? shortFingerprint(result.authorFingerprint)
          : undefined,
      })
      if (decision) {
        onInstalled?.(result)
        handleOpenChange(false)
      } else {
        // User cancelled the grant sheet — leave the install in place but
        // close the URL dialog so they can grant later from the per-plugin
        // permission UI.
        onInstalled?.(result)
        handleOpenChange(false)
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error))
      setStage("error")
    }
  }, [
    preview,
    publisherAlreadyTrusted,
    trustAuthor,
    bundleUrl,
    signatureUrl,
    publicKey,
    grant,
    onInstalled,
    handleOpenChange,
    trustRequiredError,
  ])

  const canPreview = useMemo(() => {
    if (!bundleUrl.trim()) return false
    // If the user typed a signature URL, they must also paste the key.
    if (signatureUrl.trim() && !publicKey.trim()) return false
    return true
  }, [bundleUrl, signatureUrl, publicKey])

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="w-[95vw] max-w-xl" data-testid="install-from-url-dialog">
          <DialogHeader>
            <DialogTitle>{t("title")}</DialogTitle>
            <DialogDescription>{t("description")}</DialogDescription>
          </DialogHeader>

          {(stage === "input" || stage === "error") && (
            <div className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor="bundle-url">{t("bundleUrlLabel")}</Label>
                <Input
                  id="bundle-url"
                  type="url"
                  placeholder={t("bundleUrlPlaceholder")}
                  value={bundleUrl}
                  onChange={(e) => setBundleUrl(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="sig-url">{t("signatureUrlLabel")}</Label>
                <Input
                  id="sig-url"
                  type="url"
                  placeholder={t("signatureUrlPlaceholder")}
                  value={signatureUrl}
                  onChange={(e) => setSignatureUrl(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="pubkey">{t("publicKeyLabel")}</Label>
                <Input
                  id="pubkey"
                  type="text"
                  placeholder={t("publicKeyPlaceholder")}
                  value={publicKey}
                  onChange={(e) => setPublicKey(e.target.value)}
                />
              </div>
              {stage === "error" && errorMessage && (
                <div
                  className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm"
                  role="alert"
                >
                  <AlertCircleIcon className="size-4 text-destructive mt-0.5" aria-hidden />
                  <span>{errorMessage}</span>
                </div>
              )}
            </div>
          )}

          {stage === "preview" && preview && (
            <div className="space-y-3" data-testid="install-from-url-preview">
              <div className="rounded-md border p-3 space-y-1">
                <div className="text-sm font-semibold">
                  {preview.manifest.name}{" "}
                  <span className="font-normal text-muted-foreground">
                    v{preview.manifest.version}
                  </span>
                </div>
                <div className="text-xs text-muted-foreground">{preview.manifest.description}</div>
              </div>
              <div className="rounded-md border p-3 flex items-start gap-2">
                <KeyRoundIcon className="size-4 mt-0.5 text-muted-foreground" aria-hidden />
                <div className="text-sm space-y-1">
                  <div className="font-medium">
                    {preview.manifest.author?.name ?? t("anonymousAuthor")}
                  </div>
                  {preview.authorFingerprint ? (
                    <div className="font-mono text-xs text-muted-foreground break-all">
                      {shortFingerprint(preview.authorFingerprint)}
                    </div>
                  ) : (
                    <div className="text-xs text-muted-foreground">{t("noAuthorKey")}</div>
                  )}
                  {preview.signatureVerified ? (
                    <Badge variant="outline" className="text-emerald-600 border-emerald-500/40">
                      <ShieldCheckIcon className="size-3 mr-1" aria-hidden />
                      {t("signatureVerified")}
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-amber-600 border-amber-500/40">
                      {t("unsignedBundle")}
                    </Badge>
                  )}
                </div>
              </div>
              {preview.signatureVerified && (
                <label className="flex items-start gap-2 text-sm">
                  <Checkbox
                    checked={trustAuthor}
                    onCheckedChange={(checked) => setTrustAuthor(checked === true)}
                    aria-label={t("trustAriaLabel")}
                    data-testid="trust-author-checkbox"
                  />
                  <span>
                    {publisherAlreadyTrusted ? (
                      <>
                        <CheckCircle2Icon
                          className="size-3.5 inline mr-1 text-emerald-500"
                          aria-hidden
                        />
                        {t("alreadyTrusted")}
                      </>
                    ) : (
                      <>{t("trustFirstTime")}</>
                    )}
                  </span>
                </label>
              )}
              {errorMessage && (
                <div
                  className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm"
                  role="alert"
                >
                  <AlertCircleIcon className="size-4 text-destructive mt-0.5" aria-hidden />
                  <span>{errorMessage}</span>
                </div>
              )}
            </div>
          )}

          {stage === "installing" && (
            <div className="flex items-center justify-center py-8">
              <Loader2Icon className="size-5 animate-spin text-muted-foreground" aria-hidden />
              <span className="ml-2 text-sm">
                {preview ? t("installing") : t("fetchingManifest")}
              </span>
            </div>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => handleOpenChange(false)}
              data-testid="install-from-url-cancel"
            >
              {t("cancel")}
            </Button>
            {(stage === "input" || stage === "error") && (
              <Button
                onClick={handlePreview}
                disabled={!canPreview}
                data-testid="install-from-url-preview-button"
              >
                {t("preview")}
              </Button>
            )}
            {stage === "preview" && (
              <Button onClick={handleConfirm} data-testid="install-from-url-confirm-button">
                {t("install")}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {grant.sheet}
    </>
  )
}
