"use client"

/**
 * The Canvas "new document" flow.
 *
 * The old one was a single unlabelled call:
 * `create({ title: "Untitled", content: "", language: "markdown", type: "text" })`.
 * Whatever you wanted, you got an empty Markdown document and then changed the
 * language afterwards from a different panel. There was no way to start from a
 * file at all, in a subsystem whose whole job is editing documents.
 *
 * This asks the four questions that decide what the document is: type,
 * language, starter, or a file to import. Import is the only one that can fail
 * or lose information, so it reports both before anything is created.
 */

import { useCallback, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { AlertTriangle, FileUp, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { LANGUAGE_OPTIONS } from "@/lib/canvas/constants"
import {
  EMPTY_STARTER_ID,
  defaultTypeForLanguage,
  findStarter,
  startersForLanguage,
} from "@/lib/canvas/document-starters"
import {
  importCanvasDocument,
  type CanvasImportResult,
  type CanvasImportWarning,
} from "@/lib/canvas/document-import"
import { loggers } from "@cognia/logging"
import type { ArtifactLanguage } from "@/types"

export interface CanvasNewDocumentRequest {
  title: string
  content: string
  language: ArtifactLanguage
  type: "code" | "text"
}

export interface CanvasNewDocumentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreate: (request: CanvasNewDocumentRequest) => void
}

export function CanvasNewDocumentDialog({
  open,
  onOpenChange,
  onCreate,
}: CanvasNewDocumentDialogProps) {
  const t = useTranslations("canvas.newDocumentDialog")
  const tCanvas = useTranslations("canvas")

  const [title, setTitle] = useState("")
  const [language, setLanguage] = useState<ArtifactLanguage>("markdown")
  const [starterId, setStarterId] = useState<string>(EMPTY_STARTER_ID)
  const [imported, setImported] = useState<CanvasImportResult | null>(null)
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const starters = useMemo(() => startersForLanguage(language), [language])

  const reset = useCallback(() => {
    setTitle("")
    setLanguage("markdown")
    setStarterId(EMPTY_STARTER_ID)
    setImported(null)
    setImporting(false)
    setImportError(null)
  }, [])

  const close = useCallback(
    (next: boolean) => {
      if (!next) reset()
      onOpenChange(next)
    },
    [onOpenChange, reset]
  )

  const handleFile = useCallback(async (file: File | undefined) => {
    if (!file) return
    setImporting(true)
    setImportError(null)
    try {
      const result = await importCanvasDocument(file)
      setImported(result)
      // The parsed title is a better default than "Untitled", and the user can
      // still override it in the field above.
      setTitle((current) => current || result.title)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      loggers.canvas.error("canvas import failed", { filename: file.name, error: message })
      setImportError(message)
      setImported(null)
    } finally {
      setImporting(false)
    }
  }, [])

  const submitBlank = useCallback(() => {
    const starter = starterId === EMPTY_STARTER_ID ? undefined : findStarter(starterId)
    onCreate({
      title: title.trim() || tCanvas("untitledDefault"),
      content: starter?.content ?? "",
      language,
      type: starter?.type ?? defaultTypeForLanguage(language),
    })
    close(false)
  }, [close, language, onCreate, starterId, tCanvas, title])

  const submitImport = useCallback(() => {
    if (!imported) return
    onCreate({
      title: title.trim() || imported.title,
      content: imported.content,
      language: imported.language,
      type: imported.type,
    })
    close(false)
  }, [close, imported, onCreate, title])

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-lg" data-testid="canvas-new-document-dialog">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label htmlFor="canvas-new-title">{t("nameLabel")}</Label>
          <Input
            id="canvas-new-title"
            data-testid="canvas-new-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={tCanvas("untitledDefault")}
          />
        </div>

        <Tabs defaultValue="blank">
          <TabsList className="w-full">
            <TabsTrigger value="blank" className="flex-1" data-testid="canvas-new-tab-blank">
              {t("tabBlank")}
            </TabsTrigger>
            <TabsTrigger value="import" className="flex-1" data-testid="canvas-new-tab-import">
              {t("tabImport")}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="blank" className="space-y-3 pt-3">
            <div className="space-y-2">
              <Label htmlFor="canvas-new-language">{t("languageLabel")}</Label>
              <Select
                value={language}
                onValueChange={(next) => {
                  setLanguage(next as ArtifactLanguage)
                  // A starter belongs to one language, so keeping the old
                  // selection would silently create a document in the wrong one.
                  setStarterId(EMPTY_STARTER_ID)
                }}
              >
                <SelectTrigger id="canvas-new-language" data-testid="canvas-new-language">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LANGUAGE_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="canvas-new-starter">{t("starterLabel")}</Label>
              <Select value={starterId} onValueChange={setStarterId}>
                <SelectTrigger id="canvas-new-starter" data-testid="canvas-new-starter">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={EMPTY_STARTER_ID}>{t("starters.empty")}</SelectItem>
                  {starters.map((starter) => (
                    <SelectItem key={starter.id} value={starter.id}>
                      {t(`starters.${starter.id}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <DialogFooter>
              <Button variant="ghost" onClick={() => close(false)}>
                {tCanvas("cancel")}
              </Button>
              <Button onClick={submitBlank} data-testid="canvas-new-create">
                {t("create")}
              </Button>
            </DialogFooter>
          </TabsContent>

          <TabsContent value="import" className="space-y-3 pt-3">
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              data-testid="canvas-new-file-input"
              onChange={(event) => void handleFile(event.target.files?.[0])}
            />
            <Button
              variant="outline"
              className="w-full"
              disabled={importing}
              onClick={() => fileInputRef.current?.click()}
              data-testid="canvas-new-choose-file"
            >
              {importing ? (
                <Loader2 className="mr-2 size-4 animate-spin" />
              ) : (
                <FileUp className="mr-2 size-4" />
              )}
              {importing ? t("importing") : t("chooseFile")}
            </Button>

            {importError && (
              <Alert variant="destructive" data-testid="canvas-new-import-error">
                <AlertDescription className="text-xs">
                  {t("importFailed", { error: importError })}
                </AlertDescription>
              </Alert>
            )}

            {imported && (
              <div className="space-y-2" data-testid="canvas-new-import-summary">
                <p className="text-xs text-muted-foreground">
                  {t("importedSummary", {
                    filename: imported.sourceFilename,
                    language: imported.language,
                  })}
                </p>
                {imported.warnings.length > 0 && (
                  <Alert data-testid="canvas-new-import-warnings">
                    <AlertTriangle className="size-4" />
                    <AlertDescription className="space-y-1 text-xs">
                      {imported.warnings.map((warning, index) => (
                        <p key={`${warning.code}-${index}`}>{warningText(warning, t)}</p>
                      ))}
                    </AlertDescription>
                  </Alert>
                )}
              </div>
            )}

            <DialogFooter>
              <Button variant="ghost" onClick={() => close(false)}>
                {tCanvas("cancel")}
              </Button>
              <Button
                onClick={submitImport}
                disabled={!imported}
                data-testid="canvas-new-import-create"
              >
                {t("create")}
              </Button>
            </DialogFooter>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}

/**
 * One warning line.
 *
 * Conversion and emptiness carry the source format in `message`. A parser
 * diagnostic carries its own sentence, which is already written for a person,
 * so it is passed through rather than re-worded.
 */
function warningText(
  warning: CanvasImportWarning,
  t: (key: string, values?: Record<string, string>) => string
): string {
  if (warning.code === "converted-to-markdown") {
    return t("warningConverted", { format: warning.message })
  }
  if (warning.code === "empty") {
    return t("warningEmpty")
  }
  return warning.message
}
