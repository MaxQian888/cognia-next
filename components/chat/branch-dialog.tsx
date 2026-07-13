"use client"

// Conversation-branching dialog. Opened from a message's action toolbar
// (desktop) or the long-press action sheet (mobile). Lets the user fork the
// thread at the chosen message into a new, independent session — either a
// verbatim "direct" branch or a "summary" branch seeded with an LLM summary
// (with an editable preview before the branch is created). The original
// session is never mutated. See `lib/chat/branch-session.ts`.

import { useState } from "react"
import { useLocale, useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Loader2Icon } from "lucide-react"
import { useChatStore, selectVisibleMessages } from "@/stores/chat/chat-store"
import { useSettingsStore } from "@/stores/settings"
import { useProjectStore } from "@/stores/project/project-store"
import { getSession } from "@/lib/db/sessions"
import { buildUtilityLlmClient } from "@/lib/ai/generation/utility-client"
import { summarizeConversation } from "@/lib/ai/generation/summarizer"
import { branchSessionAtMessage, type BranchMode } from "@/lib/chat/branch-session"
import { createLogger } from "@cognia/logging"

const log = createLogger("chat-branch")

interface Props {
  /** Source session id (the active conversation). */
  sessionId: string
  /** The message to branch at (inclusive cut-off). */
  messageId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function BranchDialog({ sessionId, messageId, open, onOpenChange }: Props) {
  const t = useTranslations("chat.branch")
  const locale = useLocale()
  const [mode, setMode] = useState<BranchMode>("direct")
  const [summaryText, setSummaryText] = useState("")
  const [generating, setGenerating] = useState(false)
  const [creating, setCreating] = useState(false)

  // Reset transient state on close so the next open starts fresh — avoids a
  // setState-in-effect cascade (the desktop toolbar keeps this dialog mounted).
  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setMode("direct")
      setSummaryText("")
      setGenerating(false)
      setCreating(false)
    }
    onOpenChange(next)
  }

  const visibleMessages = () => {
    const { messages, activeBranchByGroup } = useChatStore.getState()
    return selectVisibleMessages(messages, activeBranchByGroup)
  }

  const keptUpToMessage = () => {
    const visible = visibleMessages()
    const idx = visible.findIndex((m) => m.id === messageId)
    return idx < 0 ? [] : visible.slice(0, idx + 1)
  }

  const generateSummary = async () => {
    setGenerating(true)
    try {
      const session = await getSession(sessionId)
      const appSettings = useSettingsStore.getState().settings
      const client = buildUtilityLlmClient({
        session,
        appSettings,
        featureId: "conversation-summary",
      })
      const summary = await summarizeConversation(keptUpToMessage(), { client, locale })
      setSummaryText(summary)
    } catch (err) {
      log.error("branch-summary-failed", { sessionId, error: String(err) })
      toast.error(t("summaryError"))
    } finally {
      setGenerating(false)
    }
  }

  // Auto-generate the first summary when the user switches to summary mode.
  const onModeChange = (next: string) => {
    const m = next as BranchMode
    setMode(m)
    if (m === "summary" && !summaryText && !generating) void generateSummary()
  }

  const onConfirm = async () => {
    if (mode === "summary" && !summaryText.trim()) {
      toast.error(t("summaryEmpty"))
      return
    }
    setCreating(true)
    try {
      const child = await branchSessionAtMessage({
        sourceId: sessionId,
        visibleMessages: visibleMessages(),
        messageId,
        mode,
        summaryText: mode === "summary" ? summaryText : undefined,
      })
      // Link to the active workspace and switch to the new branch — mirrors the
      // "new conversation" flow (`hooks/chat/use-sessions.ts:create`).
      const { activeProjectId, addSessionToProject } = useProjectStore.getState()
      if (activeProjectId) addSessionToProject(activeProjectId, child.id)
      useChatStore.getState().setActiveSession(child.id)
      toast.success(t("created"))
      handleOpenChange(false)
    } catch (err) {
      log.error("branch-create-failed", { sessionId, messageId, mode, error: String(err) })
      toast.error(t("createError"))
    } finally {
      setCreating(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <RadioGroup value={mode} onValueChange={onModeChange} className="gap-3">
            <label className="flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm">
              <RadioGroupItem value="direct" className="mt-0.5" />
              <span>
                <span className="font-medium">{t("direct.label")}</span>
                <span className="text-muted-foreground block text-xs">{t("direct.hint")}</span>
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm">
              <RadioGroupItem value="summary" className="mt-0.5" />
              <span>
                <span className="font-medium">{t("summary.label")}</span>
                <span className="text-muted-foreground block text-xs">{t("summary.hint")}</span>
              </span>
            </label>
          </RadioGroup>

          {mode === "summary" && (
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <Label className="text-xs">{t("summary.previewLabel")}</Label>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-xs"
                  onClick={() => void generateSummary()}
                  disabled={generating}
                >
                  {generating && <Loader2Icon className="mr-1 size-3 animate-spin" />}
                  {t("summary.regenerate")}
                </Button>
              </div>
              <Textarea
                value={summaryText}
                onChange={(e) => setSummaryText(e.target.value)}
                rows={6}
                placeholder={generating ? t("summary.generating") : t("summary.placeholder")}
                disabled={generating}
              />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={creating}>
            {t("cancel")}
          </Button>
          <Button onClick={() => void onConfirm()} disabled={creating || generating}>
            {creating && <Loader2Icon className="mr-1.5 size-4 animate-spin" />}
            {t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
