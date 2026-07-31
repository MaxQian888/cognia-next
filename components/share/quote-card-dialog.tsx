"use client"

// "Share as card" dialog: turns a single chat message into a styled quote card,
// previews it live, and offers the two quick-share paths — download as PNG
// (html2canvas-pro) and publish through the zero-knowledge ShareLinkDialog
// (`chat-quote` kind). Mirrors UsageShareDialog.

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import html2canvas from "html2canvas-pro"
import { ImageDownIcon, Link2Icon, MessageSquareQuoteIcon } from "lucide-react"
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
import { quoteCardPayload } from "@/lib/share/payload"
import { buildQuoteCardHtml, renderQuoteCardFragment } from "@/lib/export/html/quote-card"
import { THEMES, type ThemeId } from "@/lib/export/html/syntax-themes"
import { themeHasWallpaper, resolveThemeWallpaper } from "@/lib/export/html/theme-wallpaper"
import { saveExport } from "@/lib/files/save-export"
import { createLogger } from "@cognia/logging"

const log = createLogger("quote-card-share")

interface Props {
  role: string
  authorName?: string
  text: string
  model?: string
  timestamp: Date
  sessionTitle?: string
  trigger?: React.ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

export function QuoteCardDialog({
  role,
  authorName,
  text,
  model,
  timestamp,
  sessionTitle,
  trigger,
  open,
  onOpenChange,
}: Props) {
  const t = useTranslations("share.quoteCard")
  const [theme, setTheme] = useState<ThemeId>("arknights")
  const [withWallpaper, setWithWallpaper] = useState(false)
  const [wallpaperDataUrl, setWallpaperDataUrl] = useState<string>()
  const [downloading, setDownloading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    void resolveThemeWallpaper(theme, withWallpaper).then((url) => {
      if (live) setWallpaperDataUrl(url)
    })
    return () => {
      live = false
    }
  }, [theme, withWallpaper])

  const cardOptions = useMemo(
    () => ({ role, authorName, text, model, timestamp, sessionTitle, theme, wallpaperDataUrl }),
    [role, authorName, text, model, timestamp, sessionTitle, theme, wallpaperDataUrl]
  )
  const html = useMemo(() => buildQuoteCardHtml(cardOptions), [cardOptions])

  const onDownloadPng = async () => {
    setDownloading(true)
    setError(null)
    const host = document.createElement("div")
    host.style.position = "fixed"
    host.style.left = "-10000px"
    host.style.top = "0"
    host.innerHTML = renderQuoteCardFragment(cardOptions)
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
      const outcome = await saveExport({
        filename: `cognia-message-card-${new Date().toISOString().slice(0, 10)}.png`,
        data: blob,
        mimeType: "image/png",
      })
      if (outcome.kind === "error") {
        throw new Error(outcome.message)
      }
    } catch (e) {
      log.error("quote-card-png-failed", { error: e instanceof Error ? e.message : String(e) })
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
            <MessageSquareQuoteIcon className="size-4" />
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
                data-testid="quote-card-wallpaper"
              />
            </label>
          )}

          <iframe
            className="h-[360px] w-full rounded-lg border border-border"
            title={t("previewTitle")}
            sandbox=""
            srcDoc={html}
            data-testid="quote-card-preview"
          />
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => void onDownloadPng()}
            data-testid="quote-card-download"
          >
            <ImageDownIcon className="mr-1.5 size-4" />
            {downloading ? t("downloading") : t("downloadPng")}
          </Button>
          <ShareLinkDialog
            buildPayload={() => quoteCardPayload(html, sessionTitle || t("cardTitle"))}
            trigger={
              <Button data-testid="quote-card-share-link">
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
