"use client"

/**
 * The Canvas AI workbench panel.
 *
 * It replaced a grid of eight buttons that dispatched a window event and showed
 * nothing back. `review` returned text nobody rendered, `explain` returned text
 * nobody rendered, `run` asked a model to imagine executing the code, and a
 * failure surfaced only as a line of red over in the editor pane.
 *
 * Every field of `CanvasAIWorkbenchState` has a control here, and every control
 * writes back to the document, so a draft instruction survives switching away
 * and coming back. The run itself comes from the shell-wide actions context, so
 * the output the editor pane produced is the output this panel renders.
 */

import { useCallback, useMemo } from "react"
import { useTranslations } from "next-intl"
import {
  Bug,
  Expand,
  HelpCircle,
  Languages,
  Lightbulb,
  Minimize2,
  Play,
  RotateCcw,
  Send,
  Sparkles,
  Wand2,
  X,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Spinner } from "@/components/ui/spinner"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useArtifactStore, DEFAULT_CANVAS_WORKBENCH } from "@/stores/artifact/artifact-store"
import { TRANSLATE_LANGUAGES } from "@/lib/canvas/constants"
import { cn } from "@/lib/utils"
import type { CanvasWorkbenchActionType } from "@/types/artifact/artifact"
import { useSharedCanvasActions } from "./canvas-actions-context"

/** The presets the panel offers, in the order they are shown. */
const PRESETS: Array<{ action: CanvasWorkbenchActionType; icon: typeof Wand2; labelKey: string }> =
  [
    { action: "review", icon: Wand2, labelKey: "review" },
    { action: "fix", icon: Bug, labelKey: "fix" },
    { action: "improve", icon: Sparkles, labelKey: "improve" },
    { action: "explain", icon: HelpCircle, labelKey: "explain" },
    { action: "simplify", icon: Minimize2, labelKey: "simplify" },
    { action: "expand", icon: Expand, labelKey: "expand" },
    { action: "run", icon: Play, labelKey: "run" },
  ]

export interface CanvasAiPanelProps {
  documentId: string
}

export function CanvasAiPanel({ documentId }: CanvasAiPanelProps) {
  const t = useTranslations("canvas.actions")
  const tPanel = useTranslations("canvas.aiPanel")
  const actions = useSharedCanvasActions()

  const workbench = useArtifactStore(
    (s) => s.canvasDocuments[documentId]?.aiWorkbench ?? DEFAULT_CANVAS_WORKBENCH
  )
  const updateWorkbench = useArtifactStore((s) => s.updateCanvasWorkbench)

  const dispatchAction = useCallback(
    (type: CanvasWorkbenchActionType, targetLanguage?: string) => {
      updateWorkbench(documentId, { selectedPresetAction: type })
      window.dispatchEvent(
        new CustomEvent("canvas-action", {
          detail: {
            type,
            targetLanguage,
            prompt: workbench.promptDraft.trim() || undefined,
            proposalFirst: true,
          },
        })
      )
    },
    [documentId, updateWorkbench, workbench.promptDraft]
  )

  const submitDraft = useCallback(() => {
    const prompt = workbench.promptDraft.trim()
    if (!prompt) return
    // A typed instruction with no preset chosen is the `custom` action, which
    // is the one preset that has always existed and never had a control.
    dispatchAction(workbench.selectedPresetAction ?? "custom")
  }, [dispatchAction, workbench.promptDraft, workbench.selectedPresetAction])

  const history = useMemo(() => workbench.actionHistory.slice(0, 6), [workbench.actionHistory])

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="canvas-ai-panel">
      <div className="shrink-0 space-y-2 border-b p-3">
        <Textarea
          data-testid="canvas-ai-prompt"
          value={workbench.promptDraft}
          onChange={(event) => updateWorkbench(documentId, { promptDraft: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              submitDraft()
            }
          }}
          placeholder={tPanel("promptPlaceholder")}
          className="min-h-16 resize-none text-xs"
          aria-label={tPanel("promptLabel")}
        />
        <div className="flex items-center justify-between gap-2">
          {workbench.attachments.length > 0 ? (
            <Badge variant="outline" className="text-[10px]">
              {tPanel("attachmentCount", { count: workbench.attachments.length })}
            </Badge>
          ) : (
            <span className="text-[10px] text-muted-foreground">{tPanel("submitHint")}</span>
          )}
          <Button
            size="sm"
            className="h-7"
            data-testid="canvas-ai-submit"
            disabled={!workbench.promptDraft.trim() || actions.running}
            onClick={submitDraft}
          >
            <Send className="mr-1 size-3" />
            {tPanel("submit")}
          </Button>
        </div>
      </div>

      {workbench.attachments.length > 0 && (
        <div className="shrink-0 space-y-1 border-b p-3" data-testid="canvas-ai-attachments">
          {workbench.attachments.map((attachment) => (
            <div key={attachment.id} className="flex items-center gap-1.5 text-xs">
              <span className="min-w-0 flex-1 truncate">{attachment.label}</span>
              {attachment.isMissing && (
                <Badge variant="destructive" className="text-[9px]">
                  {tPanel("attachmentMissing")}
                </Badge>
              )}
              {attachment.isTruncated && (
                <Badge variant="outline" className="text-[9px]">
                  {tPanel("attachmentTruncated")}
                </Badge>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="size-5 shrink-0"
                aria-label={tPanel("attachmentRemove", { name: attachment.label })}
                onClick={() =>
                  updateWorkbench(documentId, {
                    attachments: workbench.attachments.filter((item) => item.id !== attachment.id),
                  })
                }
              >
                <X className="size-3" />
              </Button>
            </div>
          ))}
        </div>
      )}

      <div className="grid shrink-0 gap-1.5 border-b p-3">
        {PRESETS.map(({ action, icon: Icon, labelKey }) => (
          <Button
            key={action}
            variant={workbench.selectedPresetAction === action ? "secondary" : "outline"}
            size="sm"
            className="h-8 justify-start"
            data-testid={`canvas-ai-preset-${action}`}
            disabled={actions.running}
            onClick={() => dispatchAction(action)}
          >
            <Icon className="mr-2 size-3.5" />
            {t(labelKey)}
          </Button>
        ))}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="h-8 justify-start"
              disabled={actions.running}
            >
              <Languages className="mr-2 size-3.5" />
              {t("translate")}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {TRANSLATE_LANGUAGES.map((language) => (
              <DropdownMenuItem
                key={language.value}
                onClick={() => dispatchAction("translate", language.value)}
              >
                {language.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          variant="outline"
          size="sm"
          className="h-8 justify-start"
          disabled={actions.running}
          onClick={() => window.dispatchEvent(new CustomEvent("canvas-action-suggest"))}
        >
          <Lightbulb className="mr-2 size-3.5" />
          {t("suggest")}
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-3 p-3">
          {actions.running && (
            <div
              className="flex items-center gap-2 text-xs text-muted-foreground"
              data-testid="canvas-ai-running"
            >
              <Spinner className="size-3" />
              <span className="flex-1">
                {tPanel("running", { action: actions.actionType ?? "" })}
              </span>
              {actions.cancellable && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs"
                  data-testid="canvas-ai-cancel"
                  onClick={actions.cancel}
                >
                  {tPanel("cancel")}
                </Button>
              )}
            </div>
          )}

          {actions.error && (
            <Alert variant="destructive" data-testid="canvas-ai-error">
              <AlertDescription className="space-y-2 text-xs">
                <p>
                  {actions.errorKind === "pii-blocked"
                    ? tPanel("errorPiiBlocked")
                    : actions.errorKind === "cancelled"
                      ? tPanel("errorCancelled")
                      : actions.error}
                </p>
                {actions.retryable && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 px-2 text-xs"
                    data-testid="canvas-ai-retry"
                    onClick={() => void actions.retry().catch(() => undefined)}
                  >
                    <RotateCcw className="mr-1 size-3" />
                    {tPanel("retry")}
                  </Button>
                )}
              </AlertDescription>
            </Alert>
          )}

          {actions.output && (
            <div className="space-y-1" data-testid="canvas-ai-output">
              <p className="text-[10px] font-medium uppercase text-muted-foreground">
                {tPanel("outputHeading")}
              </p>
              <div
                className={cn(
                  "whitespace-pre-wrap rounded border bg-muted/30 p-2 text-xs",
                  actions.running && "opacity-80"
                )}
              >
                {actions.output}
              </div>
            </div>
          )}

          {history.length > 0 && (
            <div className="space-y-1" data-testid="canvas-ai-history">
              <p className="text-[10px] font-medium uppercase text-muted-foreground">
                {tPanel("historyHeading")}
              </p>
              {history.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className="flex w-full items-center gap-1.5 rounded px-1 py-1 text-left text-xs hover:bg-muted/50"
                  onClick={() =>
                    updateWorkbench(documentId, {
                      promptDraft: entry.prompt,
                      selectedPresetAction: entry.actionType,
                    })
                  }
                >
                  <span className="min-w-0 flex-1 truncate">
                    {entry.prompt || t(entry.actionType)}
                  </span>
                  <Badge variant="outline" className="shrink-0 text-[9px]">
                    {tPanel(`status.${entry.status}`)}
                  </Badge>
                </button>
              ))}
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
