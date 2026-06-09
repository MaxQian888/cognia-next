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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useSingleExport } from "@/hooks/data/use-single-export"
import { ShareLinkDialog } from "@/components/share/share-link-dialog"
import { buildChatSharePayload } from "@/lib/share/chat-export"
import { Link2Icon } from "lucide-react"
import { CustomThemeEditor } from "./custom-theme-editor"
import { THEME_LIST, type ThemeId } from "@/lib/export/html/syntax-themes"
import { useCustomThemeStore } from "@/stores/theme"
import type { ChatSession } from "@/lib/claude/types"
import type { SingleExportFormat } from "@/lib/export/single"
import { toast } from "sonner"
import { createLogger } from "@/lib/logging"

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
  const tData = useTranslations("settings.data")
  const tShare = useTranslations("share")
  const [format, setFormat] = useState<SingleExportFormat>(defaultFormat)
  const [theme, setTheme] = useState<ThemeId>("light")
  const [customThemeId, setCustomThemeId] = useState<string | null>(null)
  const [includeMetadata, setIncludeMetadata] = useState(true)
  const [includeTimestamps, setIncludeTimestamps] = useState(true)
  const [includeTokens, setIncludeTokens] = useState(false)
  const [includeAllBranches, setIncludeAllBranches] = useState(false)
  const customTheme = useCustomThemeStore((s) =>
    customThemeId
      ? (s.themes.find((th) => th.id === customThemeId)?.tokens ?? undefined)
      : undefined
  )
  const { run, busy } = useSingleExport()

  const isHtml = format === "html" || format === "animated"
  const isJsonl = format === "jsonl" || format === "jsonl-chat"

  const onSubmit = async () => {
    const result = await run({
      format,
      session,
      theme,
      customTheme,
      includeMetadata,
      includeTimestamps,
      includeTokens,
      includeAllBranches,
    })
    if (result.ok) {
      if (!result.canceled) {
        log.info("single-export-completed", { sessionId: session.id, format })
        toast.success(tData("exportSuccess"))
      }
    } else {
      log.error("single-export-failed", {
        sessionId: session.id,
        format,
        error: result.error,
      })
      toast.error(result.error)
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
                <Select value={theme} onValueChange={(v) => setTheme(v as ThemeId)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {THEME_LIST.map((th) => (
                      <SelectItem key={th.id} value={th.id}>
                        {th.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
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
        </div>

        <DialogFooter>
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
