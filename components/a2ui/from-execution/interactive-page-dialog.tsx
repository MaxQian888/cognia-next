"use client"

/**
 * InteractivePageDialog — turn an execution source (workflow run / conversation)
 * into a shareable A2UI page.
 *
 * Pipeline (all existing machinery, this only bridges it):
 *   source → buildExecutionPage() → baseline A2UI app
 *          → [optional] enhanceExecutionPage() → applyEnhancement()
 *          → preview via A2UISurface (readOnly)
 *          → Save to mini-app hub (createCustomApp) OR Share link (a2uiPayload).
 *
 * The page is built lazily on open; the preview surface is created in the A2UI
 * store under an ephemeral id and torn down on close.
 */

import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Loader2, Sparkles } from "lucide-react"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { A2UISurface } from "@/components/a2ui/a2ui-surface"
import { ShareLinkDialog } from "@/components/share/share-link-dialog"
import { useA2UIStore } from "@/stores/a2ui"
import { useA2UIAppBuilder } from "@/hooks/a2ui/use-app-builder"
import { useSettingsStore } from "@/stores/settings"
import { createA2UISurface } from "@/lib/a2ui/parser"
import { a2uiPayload } from "@/lib/share/payload"
import type { GeneratedApp } from "@/lib/a2ui/app-generator"
import {
  applyEnhancement,
  buildExecutionPage,
  buildSourceDigest,
  enhanceExecutionPage,
  type ExecutionPageLabels,
  type ExecutionPageSource,
} from "@/lib/a2ui/from-execution"

/** Build the localized label bag the pure projectors consume. */
function useExecutionPageLabels(): ExecutionPageLabels {
  const t = useTranslations("a2ui.interactivePage")
  return useMemo(
    () => ({
      status: t("status"),
      trigger: t("trigger"),
      duration: t("duration"),
      tokens: t("tokens"),
      cost: t("cost"),
      steps: t("steps"),
      succeeded: t("succeeded"),
      failed: t("failed"),
      stepBreakdown: t("stepBreakdown"),
      stepDuration: t("stepDuration"),
      tokenBurn: t("tokenBurn"),
      outputs: t("outputs"),
      error: t("error"),
      model: t("model"),
      messages: t("messages"),
      user: t("user"),
      assistant: t("assistant"),
      toolCalls: t("toolCalls"),
      turns: t("turns"),
      turn: t("turn"),
      role: t("role"),
      preview: t("preview"),
      finalOutput: t("finalOutput"),
      summary: t("summary"),
      insights: t("insights"),
      untitled: t("untitled"),
      unknown: t("unknown"),
    }),
    [t]
  )
}

/** A source given directly, or a (possibly async) resolver run lazily on open. */
type SourceInput = ExecutionPageSource | (() => ExecutionPageSource | Promise<ExecutionPageSource>)

interface Props {
  source: SourceInput
  trigger: ReactNode
}

export function InteractivePageDialog({ source, trigger }: Props) {
  const t = useTranslations("a2ui.interactivePage")
  const labels = useExecutionPageLabels()
  const router = useRouter()

  const [open, setOpen] = useState(false)
  const [resolvedSource, setResolvedSource] = useState<ExecutionPageSource | null>(null)
  const [app, setApp] = useState<GeneratedApp | null>(null)
  const [name, setName] = useState("")
  const [enhancing, setEnhancing] = useState(false)

  const previewId = useId()
  const processMessages = useA2UIStore((s) => s.processMessages)
  const deleteSurface = useA2UIStore((s) => s.deleteSurface)
  const { createCustomApp } = useA2UIAppBuilder({})

  const session = resolvedSource?.kind === "conversation" ? resolvedSource.session : null

  // Build the baseline page when the dialog opens; reset when it closes.
  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next)
      if (next) {
        void Promise.resolve(typeof source === "function" ? source() : source).then((resolved) => {
          const built = buildExecutionPage(resolved, labels)
          setResolvedSource(resolved)
          setApp(built)
          setName(built.name)
        })
      } else {
        setResolvedSource(null)
        setApp(null)
        setEnhancing(false)
      }
    },
    [source, labels]
  )

  // Mirror the current app into an ephemeral preview surface.
  useEffect(() => {
    if (!app) return
    const messages = createA2UISurface(previewId, app.components, app.dataModel, {
      surfaceType: "inline",
      title: app.name,
    })
    processMessages(messages)
    return () => deleteSurface(previewId)
  }, [app, previewId, processMessages, deleteSurface])

  const handleEnhance = useCallback(async () => {
    if (!app || !resolvedSource) return
    setEnhancing(true)
    try {
      const appSettings = useSettingsStore.getState().settings
      const digest = buildSourceDigest(resolvedSource, labels)
      const enhancement = await enhanceExecutionPage({ digest, session, appSettings })
      if (!enhancement) {
        toast.error(t("enhanceFailed"))
        return
      }
      const enhanced = applyEnhancement(app, enhancement, labels)
      setApp(enhanced)
      setName(enhanced.name)
      toast.success(t("enhanced"))
    } finally {
      setEnhancing(false)
    }
  }, [app, resolvedSource, labels, session, t])

  const handleSave = useCallback(() => {
    if (!app) return
    const finalName = name.trim() || app.name
    const id = createCustomApp(finalName, app.components, app.dataModel)
    if (!id) {
      toast.error(t("saveFailed"))
      return
    }
    toast.success(t("saved"))
    setOpen(false)
    router.push(`/a2ui?app=${encodeURIComponent(id)}`)
  }, [app, name, createCustomApp, router, t])

  const buildSharePayload = useCallback(() => {
    if (!app) throw new Error("no app")
    const finalName = name.trim() || app.name
    const json = JSON.stringify({
      app: {
        title: finalName,
        name: finalName,
        components: app.components,
        dataModel: app.dataModel,
        surfaceType: "inline",
      },
    })
    return a2uiPayload(json, finalName)
  }, [app, name])

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 overflow-hidden">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="interactive-page-name">{t("pageName")}</Label>
            <Input
              id="interactive-page-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("pageNamePlaceholder")}
            />
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border bg-muted/30 p-2">
            {app ? (
              <A2UISurface surfaceId={previewId} readOnly showLoading={false} />
            ) : (
              <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
                <Loader2 className="mr-2 size-4 animate-spin" />
                {t("building")}
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-between">
          <Button variant="outline" onClick={handleEnhance} disabled={!app || enhancing}>
            {enhancing ? (
              <Loader2 className="mr-1.5 size-4 animate-spin" />
            ) : (
              <Sparkles className="mr-1.5 size-4" />
            )}
            {t("aiEnhance")}
          </Button>
          <div className="flex flex-col gap-2 sm:flex-row">
            <ShareLinkDialog
              buildPayload={buildSharePayload}
              trigger={
                <Button variant="outline" disabled={!app}>
                  {t("createShareLink")}
                </Button>
              }
            />
            <Button onClick={handleSave} disabled={!app}>
              {t("saveToApps")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
