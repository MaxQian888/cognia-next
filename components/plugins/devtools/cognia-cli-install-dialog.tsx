"use client"

/**
 * Install-guidance dialog for the `cognia` plugin-author CLI. Three tabs:
 *   1. Download prebuilt — runs `download_cognia_cli` with a progress bar.
 *      Hidden on web (no FS to install into).
 *   2. Build from source — copy-pasteable `cargo install` command.
 *   3. Release tarball — deep-link to the GitHub releases page.
 *
 * Surfaced from the CLI status card's "Install" CTA and the toolbar chip.
 */

import { useCallback, useState } from "react"
import { useTranslations } from "next-intl"
import { CheckIcon, CopyIcon, DownloadIcon, ExternalLinkIcon, Loader2Icon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Progress } from "@/components/ui/progress"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { isTauri } from "@/lib/tauri"
import { openUrl } from "@/lib/native/opener"
import { downloadCogniaCli, type DownloadProgress } from "@/lib/cli-bridge/download-release"
import {
  EMBEDDED_COGNIA_RELEASE_KEY_FINGERPRINT_SHA256,
  getCliReleaseVerificationMode,
} from "@/lib/cli-bridge/embedded-pubkey"

const RELEASES_URL = "https://github.com/MaxQian888/cognia-next/releases"
const CARGO_INSTALL_CMD =
  "cargo install --locked --git https://github.com/MaxQian888/cognia-next cognia-cli"

export interface CogniaCliInstallDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called after a successful prebuilt download so the parent can re-probe. */
  onInstalled?: () => void
}

export function CogniaCliInstallDialog({
  open,
  onOpenChange,
  onInstalled,
}: CogniaCliInstallDialogProps) {
  const t = useTranslations("plugins.cliInstall")
  const supported = isTauri()
  const [progress, setProgress] = useState<DownloadProgress | null>(null)
  const [downloading, setDownloading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const verificationMode = getCliReleaseVerificationMode()

  const handleDownload = useCallback(async () => {
    setError(null)
    setDownloading(true)
    setProgress(null)
    try {
      const result = await downloadCogniaCli({
        onProgress: (p) => setProgress(p),
      })
      toast.success(result.signatureVerified ? t("downloadSuccessSigned") : t("downloadSuccess"))
      onInstalled?.()
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setDownloading(false)
    }
  }, [onInstalled, onOpenChange, t])

  const copyCargoCmd = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(CARGO_INSTALL_CMD)
      toast.success(t("copied"))
    } catch {
      toast.error(t("copyFailed"))
    }
  }, [t])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="cognia-cli-install-dialog">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <Tabs defaultValue={supported ? "download" : "source"}>
          <TabsList className="w-full">
            {supported && (
              <TabsTrigger value="download" className="flex-1">
                {t("tabDownload")}
              </TabsTrigger>
            )}
            <TabsTrigger value="source" className="flex-1">
              {t("tabSource")}
            </TabsTrigger>
            <TabsTrigger value="tarball" className="flex-1">
              {t("tabTarball")}
            </TabsTrigger>
          </TabsList>

          {supported && (
            <TabsContent value="download" className="space-y-3 pt-2">
              <p className="text-sm text-muted-foreground">{t("downloadHint")}</p>
              {downloading && (
                <div className="space-y-1.5" data-testid="cognia-cli-download-progress">
                  <Progress value={(progress?.progress ?? 0) * 100} />
                  <p className="text-xs text-muted-foreground">
                    {progress?.message ?? t("downloadStarting")}
                  </p>
                </div>
              )}
              {error && (
                <p className="text-xs text-destructive" role="alert">
                  {error}
                </p>
              )}
              <Button
                onClick={() => void handleDownload()}
                disabled={downloading}
                data-testid="cognia-cli-download-button"
              >
                {downloading ? (
                  <Loader2Icon className="mr-2 size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <DownloadIcon className="mr-2 size-4" aria-hidden="true" />
                )}
                {t("downloadButton")}
              </Button>
            </TabsContent>
          )}

          <TabsContent value="source" className="space-y-3 pt-2">
            <p className="text-sm text-muted-foreground">{t("sourceHint")}</p>
            <div className="flex items-center gap-2 rounded-md border bg-muted/40 p-2">
              <code className="flex-1 text-xs break-all font-mono">{CARGO_INSTALL_CMD}</code>
              <Button
                size="icon"
                variant="ghost"
                className="size-7 shrink-0"
                onClick={() => void copyCargoCmd()}
                aria-label={t("copy")}
                data-testid="cognia-cli-copy-cargo"
              >
                <CopyIcon className="size-3.5" />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t("sourcePrereq")}</p>
          </TabsContent>

          <TabsContent value="tarball" className="space-y-3 pt-2">
            <p className="text-sm text-muted-foreground">{t("tarballHint")}</p>
            <Button
              variant="outline"
              onClick={() => void openUrl(RELEASES_URL)}
              data-testid="cognia-cli-open-releases"
            >
              <ExternalLinkIcon className="mr-2 size-4" aria-hidden="true" />
              {t("openReleases")}
            </Button>
          </TabsContent>
        </Tabs>

        <div className="space-y-1 rounded-md border bg-muted/30 p-2 text-[11px] text-muted-foreground">
          <p className="flex items-center gap-1">
            <CheckIcon className="size-3" aria-hidden="true" />
            {t("verifyNote")}
          </p>
          <p>
            {t("verificationMode")}: {t(`verificationMode_${verificationMode}`)}
          </p>
          <p className="break-all font-mono" data-testid="cognia-cli-release-key-fingerprint">
            {t("releaseKeyFingerprint")}: {EMBEDDED_COGNIA_RELEASE_KEY_FINGERPRINT_SHA256}
          </p>
        </div>
      </DialogContent>
    </Dialog>
  )
}
