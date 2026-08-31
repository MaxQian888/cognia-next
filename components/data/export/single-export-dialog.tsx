"use client"

// Renders a single chat session as Markdown / JSON / Text / HTML / Animated.
// HTML & Animated formats expose the theme + custom-theme editor inline.

import { useState } from "react"
import { useTranslations } from "next-intl"
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
import { useSingleExport } from "@/hooks/data/use-single-export"
import { notifyExportOutcome } from "@/lib/files/export-feedback"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ShareLinkDialog } from "@/components/share/share-link-dialog"
import { ThemeGallery } from "@/components/share/theme-gallery"
import { buildChatSharePayload } from "@/lib/share/chat-export"
import { InteractivePageDialog } from "@/components/a2ui/from-execution/interactive-page-dialog"
import { saveExport } from "@/lib/files/save-export"
import { getDb } from "@/lib/db/schema"
import { Link2Icon, LayoutDashboardIcon, ImageDownIcon } from "lucide-react"
import { CustomThemeEditor } from "./custom-theme-editor"
import { type ThemeId } from "@/lib/export/html/syntax-themes"
import { themeHasWallpaper, resolveThemeWallpaper } from "@/lib/export/html/theme-wallpaper"
import { useCustomThemeStore } from "@/stores/theme"
import type { ChatSession } from "@cognia/agent-config-types"
import type { SingleExportFormat } from "@/lib/export/single"
import { createLogger } from "@cognia/logging"

const log = createLogger("data-export")

interface Props {
  session: ChatSession
  /** Render-prop trigger; when omitted, the dialog renders no trigger. */
  trigger?: React.ReactNode
  defaultFormat?: SingleExportFormat
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

export function SingleExportDialog({
  session,
  trigger,
  defaultFormat = "markdown",
  open,
  onOpenChange,
}: Props) {
  const t = useTranslations("export")
  const tShare = useTranslations("share")
  const tPage = useTranslations("a2ui.interactivePage")
  const [format, setFormat] = useState<SingleExportFormat>(defaultFormat)
  // Arknights (PRTS) is the flagship share style — default for HTML/animated.
  const [theme, setTheme] = useState<ThemeId>("arknights")
  const [customThemeId, setCustomThemeId] = useState<string | null>(null)
  const [includeMetadata, setIncludeMetadata] = useState(true)
  const [includeTimestamps, setIncludeTimestamps] = useState(true)
  const [includeTokens, setIncludeTokens] = useState(false)
  const [includeAllBranches, setIncludeAllBranches] = useState(false)
  const [withWallpaper, setWithWallpaper] = useState(false)
  const [downloadingPng, setDownloadingPng] = useState(false)
  const [pngError, setPngError] = useState<string | null>(null)
  const customTheme = useCustomThemeStore((s) =>
    customThemeId
      ? (s.themes.find((th) => th.id === customThemeId)?.tokens ?? undefined)
      : undefined
  )
  const { run, busy } = useSingleExport()

  const isHtml = format === "html" || format === "animated"
  const isJsonl = format === "jsonl" || format === "jsonl-chat"

  const onSubmit = async () => {
    const outcome = await run({
      format,
      session,
      theme,
      customTheme,
      includeMetadata,
      includeTimestamps,
      includeTokens,
      withWallpaper,
      includeAllBranches,
    })
    if (outcome.kind === "saved") {
      log.info("single-export-completed", {
        sessionId: session.id,
        format,
        platform: outcome.platform,
      })
    } else if (outcome.kind === "error") {
      log.error("single-export-failed", { sessionId: session.id, format, error: outcome.message })
    }
    notifyExportOutcome(outcome, { t, shareTitle: session.title })
  }

  const onDownloadPng = async () => {
    setDownloadingPng(true)
    setPngError(null)
    try {
      const messages = await getDb()
        .messages.where("sessionId")
        .equals(session.id)
        .sortBy("createdAt")
      const wallpaperDataUrl = await resolveThemeWallpaper(theme, withWallpaper)
      const { resolveSessionTwinProvenance } = await import("@/lib/twin/export-provenance")
      const provenance = await resolveSessionTwinProvenance(session, messages)
      const { renderChatToPng, ChatPngTooLongError } = await import("@/lib/export/html/chat-png")
      try {
        const blob = await renderChatToPng({
          session,
          messages,
          exportedAt: new Date(),
          theme,
          customTheme,
          includeMetadata,
          includeTimestamps,
          wallpaperDataUrl,
          provenance,
        })
        const slug =
          session.title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "") || "conversation"
        const outcome = await saveExport({
          filename: `${slug}.png`,
          data: blob,
          mimeType: "image/png",
        })
        if (outcome.kind === "error") {
          throw new Error(outcome.message)
        }
        notifyExportOutcome(outcome, { t, shareTitle: session.title })
      } catch (e) {
        if (e instanceof ChatPngTooLongError) {
          setPngError(t("pngTooLong"))
        } else {
          throw e
        }
      }
    } catch (e) {
      log.error("single-export-png-failed", {
        sessionId: session.id,
        error: e instanceof Error ? e.message : String(e),
      })
      setPngError(t("pngError"))
    } finally {
      setDownloadingPng(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
      <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("singleTitle")}</DialogTitle>
          <DialogDescription>{t("singleDescription", { title: session.title })}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1">
            <Label className="text-xs">{t("formatLabel")}</Label>
            <Select value={format} onValueChange={(v) => setFormat(v as SingleExportFormat)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="markdown">{t("format.markdown")}</SelectItem>
                <SelectItem value="json">{t("format.json")}</SelectItem>
                <SelectItem value="text">{t("format.text")}</SelectItem>
                <SelectItem value="html">{t("format.html")}</SelectItem>
                <SelectItem value="animated">{t("format.animated")}</SelectItem>
                <SelectItem value="jsonl">{t("format.jsonl")}</SelectItem>
                <SelectItem value="jsonl-chat">{t("format.jsonlChat")}</SelectItem>
              </SelectContent>
            </Select>
            {isJsonl && (
              <p className="text-muted-foreground text-xs">
                {t(`formatHint.${format === "jsonl" ? "jsonl" : "jsonlChat"}`)}
              </p>
            )}
          </div>

          {isHtml && (
            <>
              <div className="space-y-1">
                <Label className="text-xs">{t("themeLabel")}</Label>
                <ThemeGallery value={theme} onChange={setTheme} />
              </div>
              {themeHasWallpaper(theme) && (
                <label className="flex items-center justify-between text-sm">
                  <span>{t("options.includeWallpaper")}</span>
                  <Switch
                    checked={withWallpaper}
                    onCheckedChange={setWithWallpaper}
                    data-testid="export-wallpaper"
                  />
                </label>
              )}
              <CustomThemeEditor
                selectedId={customThemeId}
                builtInBase={theme}
                onSelect={setCustomThemeId}
              />
            </>
          )}

          <div className="space-y-2 rounded-md border p-3">
            <Label className="text-xs">{t("optionsLabel")}</Label>
            <label className="flex items-center justify-between text-sm">
              <span>{t("options.includeMetadata")}</span>
              <Switch checked={includeMetadata} onCheckedChange={setIncludeMetadata} />
            </label>
            <label className="flex items-center justify-between text-sm">
              <span>{t("options.includeTimestamps")}</span>
              <Switch checked={includeTimestamps} onCheckedChange={setIncludeTimestamps} />
            </label>
            <label className="flex items-center justify-between text-sm">
              <span>{t("options.includeTokens")}</span>
              <Switch checked={includeTokens} onCheckedChange={setIncludeTokens} />
            </label>
            {isJsonl && (
              <label className="flex items-center justify-between text-sm">
                <span>{t("options.includeAllBranches")}</span>
                <Switch checked={includeAllBranches} onCheckedChange={setIncludeAllBranches} />
              </label>
            )}
          </div>
          {pngError && <p className="text-xs text-destructive">{pngError}</p>}
        </div>

        <DialogFooter>
          {isHtml && (
            <Button
              variant="outline"
              onClick={() => void onDownloadPng()}
              disabled={downloadingPng}
              data-testid="export-download-png"
            >
              <ImageDownIcon className="mr-1.5 size-4" />
              {downloadingPng ? t("downloadingPng") : t("downloadPng")}
            </Button>
          )}
          <InteractivePageDialog
            source={async () => ({
              kind: "conversation",
              session,
              messages: await getDb()
                .messages.where("sessionId")
                .equals(session.id)
                .sortBy("createdAt"),
            })}
            trigger={
              <Button variant="outline">
                <LayoutDashboardIcon className="mr-1.5 size-4" />
                {tPage("openAction")}
              </Button>
            }
          />
          <ShareLinkDialog
            buildPayload={() =>
              buildChatSharePayload({
                format,
                session,
                theme,
                customTheme,
                includeMetadata,
                includeTimestamps,
                includeTokens,
                withWallpaper,
              })
            }
            trigger={
              <Button variant="outline">
                <Link2Icon className="mr-1.5 size-4" />
                {tShare("shareAction")}
              </Button>
            }
          />
          <Button onClick={() => void onSubmit()} disabled={busy}>
            {busy ? t("exporting") : t("exportButton")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
