"use client"

// Pick a third-party export file (ChatGPT / Claude / Gemini), preview the
// detected conversations, then commit them to the session list.
//
// Pick only — no drag-and-drop. (This said "Drag-or-pick" for a capability that
// was never built: no importer in the app has a drop target.)

import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { useChatImport } from "@/hooks/data/use-chat-import"
import { toast } from "sonner"
import { getImporterLabel, type ChatImportFormat } from "@/lib/data/import-registry"

interface Props {
  trigger: React.ReactNode
  /** Pre-select a platform tile (just affects the dialog copy). */
  defaultPlatform?: "chatgpt" | "claude" | "gemini"
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

export function ChatImportDialog({ trigger, defaultPlatform, open, onOpenChange }: Props) {
  const t = useTranslations("import")
  const flow = useChatImport()

  const onApply = async () => {
    // Read the counts from the call, not from `flow.state`: this closure was
    // captured at render time, so `flow.state` is still "preview" here no
    // matter how the write went.
    const counts = await flow.applyAll()
    if (counts) {
      toast.success(t("summary.success", { sessions: counts.sessions, messages: counts.messages }))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("dialog.title")}</DialogTitle>
          <DialogDescription>{t("dialog.description")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          {flow.state.status === "idle" && (
            <Card className="space-y-2 p-4 text-center">
              <p className="text-sm text-muted-foreground">{t("dialog.pickPrompt")}</p>
              {defaultPlatform && (
                <p className="text-[11px] text-muted-foreground">
                  {t(`platform.${defaultPlatform}.hint` as never)}
                </p>
              )}
              <Button onClick={() => void flow.pickFile()}>{t("dialog.pickButton")}</Button>
            </Card>
          )}

          {flow.state.status === "loading" && (
            <p className="text-sm italic text-muted-foreground">{t("dialog.loading")}</p>
          )}

          {flow.state.status === "preview" && (
            <Card className="space-y-2 p-3">
              <Label className="text-xs">
                {t("preview.detected", { format: formatLabel(flow.state.format) })}
              </Label>
              <p className="text-sm">
                {t("preview.summary", {
                  sessions: flow.state.conversations.length,
                  messages: flow.state.conversations.reduce((s, c) => s + c.messages.length, 0),
                })}
              </p>
              <ScrollArea className="h-44 rounded border bg-muted/20">
                <ul className="divide-y">
                  {flow.state.conversations.map((c) => (
                    <li key={c.session.id} className="px-3 py-2 text-xs">
                      <p className="truncate font-medium">{c.session.title}</p>
                      <p className="text-muted-foreground">
                        {t("preview.row", { count: c.messages.length })}
                      </p>
                    </li>
                  ))}
                </ul>
              </ScrollArea>
            </Card>
          )}

          {flow.state.status === "applying" && (
            <p className="text-sm italic text-muted-foreground">{t("dialog.applying")}</p>
          )}

          {flow.state.status === "done" && (
            <Card className="space-y-1 p-3">
              <Label className="text-sm font-medium">{t("summary.title")}</Label>
              <p className="text-xs text-muted-foreground">
                {t("summary.body", {
                  sessions: flow.state.sessionsAdded,
                  messages: flow.state.messagesAdded,
                  format: formatLabel(flow.state.format),
                })}
              </p>
            </Card>
          )}

          {flow.state.status === "error" && (
            <p className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
              {flow.state.message}
            </p>
          )}
        </div>

        <DialogFooter>
          {flow.state.status === "preview" && (
            <>
              <Button variant="ghost" onClick={flow.reset}>
                {t("dialog.cancel")}
              </Button>
              <Button onClick={() => void onApply()}>{t("dialog.applyButton")}</Button>
            </>
          )}
          {flow.state.status === "done" && (
            <Button variant="outline" onClick={flow.reset}>
              {t("dialog.done")}
            </Button>
          )}
          {flow.state.status === "error" && (
            <Button variant="outline" onClick={flow.reset}>
              {t("dialog.tryAgain")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function formatLabel(format: ChatImportFormat): string {
  switch (format) {
    case "chatgpt":
      return "ChatGPT"
    case "claude":
      return "Claude"
    case "gemini":
      return "Gemini"
    case "cognia-v3":
      return "Cognia (v3)"
    case "cognia-v1":
      return "Cognia (v1)"
    default:
      // Plugin-contributed formats are namespaced `${pluginId}:${format}` and
      // carry their own label. Fall back to the namespaced id rather than
      // "Unknown", which would hide which plugin actually matched the file.
      return getImporterLabel(format) ?? (format === "unknown" ? "Unknown" : format)
  }
}
