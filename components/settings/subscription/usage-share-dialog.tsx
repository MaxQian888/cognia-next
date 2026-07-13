"use client"

// "Share usage card" dialog: renders the aggregated usage stats as a styled
// card (Arknights/PRTS style by default), previews it live, and offers the
// two quick-share paths — download as PNG (html2canvas) and publish through
// the existing zero-knowledge ShareLinkDialog (`usage-card` kind).

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import html2canvas from "html2canvas"
import { ImageDownIcon, Link2Icon, Share2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { ShareLinkDialog } from "@/components/share/share-link-dialog"
import { ThemeGallery } from "@/components/share/theme-gallery"
import { usageCardPayload } from "@/lib/share/payload"
import {
  buildUsageCardHtml,
  collectUsageCardStats,
  renderUsageCardFragment,
} from "@/lib/usage/usage-card"
import { THEMES, type ThemeId } from "@/lib/export/html/syntax-themes"
import { themeHasWallpaper, resolveThemeWallpaper } from "@/lib/export/html/theme-wallpaper"
import { downloadBlob } from "@/lib/files/download"
import { createLogger } from "@cognia/logging"
import type { SessionUsageRow } from "@/lib/db/session-usage"

const log = createLogger("usage-share")

interface Props {
  rows: SessionUsageRow[]
  /** Human label of the active range filter, shown as the card's range tag. */
  rangeLabel?: string
  trigger?: React.ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

export function UsageShareDialog({ rows, rangeLabel, trigger, open, onOpenChange }: Props) {
  const t = useTranslations("subscription.usage.shareCard")
  const [theme, setTheme] = useState<ThemeId>("arknights")
  const [withWallpaper, setWithWallpaper] = useState(false)
  const [wallpaperDataUrl, setWallpaperDataUrl] = useState<string>()
  const [downloading, setDownloading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Resolve the (lazy-imported) wallpaper out of render so the card builders
  // stay synchronous. Feeds both the live preview and the PNG capture.
  useEffect(() => {
    let live = true
    void resolveThemeWallpaper(theme, withWallpaper).then((url) => {
      if (live) setWallpaperDataUrl(url)
    })
    return () => {
      live = false
    }
  }, [theme, withWallpaper])

  const stats = useMemo(() => collectUsageCardStats(rows), [rows])
  const cardOptions = useMemo(
    () => ({
      stats,
      theme,
      title: t("cardTitle"),
      rangeLabel,
      wallpaperDataUrl,
      generatedAt: new Date(),
    }),
    [stats, theme, rangeLabel, wallpaperDataUrl, t]
  )
  const html = useMemo(() => buildUsageCardHtml(cardOptions), [cardOptions])

  const onDownloadPng = async () => {
    setDownloading(true)
    setError(null)
    // Rasterise from a real (off-screen) DOM node — html2canvas cannot see
    // into the sandboxed preview iframe.
    const host = document.createElement("div")
    host.style.position = "fixed"
    host.style.left = "-10000px"
    host.style.top = "0"
    host.innerHTML = renderUsageCardFragment(cardOptions)
    document.body.appendChild(host)
    try {
      const canvas = await html2canvas(host, {
        backgroundColor: THEMES[theme].bg,
        scale: 2,
        logging: false,
      })
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png")
      })
      downloadBlob(blob, `cognia-usage-card-${new Date().toISOString().slice(0, 10)}.png`)
    } catch (e) {
      log.error("usage-card-png-failed", { error: e instanceof Error ? e.message : String(e) })
      setError(t("pngError"))
    } finally {
      document.body.removeChild(host)
      setDownloading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Share2Icon className="size-4" />
            {t("title")}
          </DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-1">
          <div className="space-y-1">
            <Label className="text-xs">{t("styleLabel")}</Label>
            <ThemeGallery value={theme} onChange={setTheme} />
          </div>

          {themeHasWallpaper(theme) && (
            <label className="flex items-center justify-between text-sm">
              <span>{t("wallpaperLabel")}</span>
              <Switch
                checked={withWallpaper}
                onCheckedChange={setWithWallpaper}
                data-testid="usage-card-wallpaper"
              />
            </label>
          )}

          <iframe
            className="h-[420px] w-full rounded-lg border border-border"
            title={t("previewTitle")}
            sandbox=""
            srcDoc={html}
            data-testid="usage-card-preview"
          />
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => void onDownloadPng()}
            disabled={downloading || rows.length === 0}
            data-testid="usage-card-download"
          >
            <ImageDownIcon className="mr-1.5 size-4" />
            {downloading ? t("downloading") : t("downloadPng")}
          </Button>
          <ShareLinkDialog
            buildPayload={() => usageCardPayload(html, t("cardTitle"))}
            trigger={
              <Button disabled={rows.length === 0} data-testid="usage-card-share-link">
                <Link2Icon className="mr-1.5 size-4" />
                {t("shareLink")}
              </Button>
            }
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
