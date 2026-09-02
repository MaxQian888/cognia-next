"use client"

/**
 * Import a template package from a URL.
 *
 * The Studio could open a package from disk and nothing else, so the ordinary
 * way a team publishes one (a release asset, a static host, an internal
 * artifact server) meant "download it yourself, then pick it".
 *
 * This dialog only FETCHES. What comes back goes through the same inspect and
 * trust-confirmation the file picker feeds, because a package pulled off a URL
 * is exactly as unverified as one pulled off a disk, and the one dialog that
 * shows the fingerprint and asks is the point at which either is accepted.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { LinkIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
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
import { fetchTemplatePackage } from "@/lib/templates/fetch-package"

export interface TemplateUrlImportDialogProps {
  open: boolean
  onOpenChange(open: boolean): void
  /** Handed the fetched bytes and the URL they came from. */
  onFetched(result: { bytes: Uint8Array; sourceUrl: string }): void | Promise<void>
}

export function TemplateUrlImportDialog({
  open,
  onOpenChange,
  onFetched,
}: TemplateUrlImportDialogProps) {
  const t = useTranslations("templateStudio.urlImport")
  const [url, setUrl] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const fetched = await fetchTemplatePackage(url)
      await onFetched(fetched)
      setUrl("")
      onOpenChange(false)
    } catch (caught) {
      // The guard and the fetch error both carry a message that names the
      // actual reason (bad scheme, private host, HTTP status, size ceiling), so
      // it is shown rather than collapsed into one generic sentence.
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setError(null)
        onOpenChange(next)
      }}
    >
      <DialogContent data-testid="template-url-import-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <LinkIcon className="size-4" />
            {t("title")}
          </DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="template-import-url">{t("urlLabel")}</Label>
          <Input
            id="template-import-url"
            className="h-8 font-mono text-xs"
            placeholder={t("urlPlaceholder")}
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
          {error ? (
            <p className="text-xs text-destructive" data-testid="template-url-import-error">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button onClick={() => void submit()} disabled={busy || !url.trim()}>
            {busy ? t("fetching") : t("fetch")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
