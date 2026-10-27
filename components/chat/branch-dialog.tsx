"use client"

// Conversation-branching dialog. Opened from a message's action toolbar
// (desktop) or the long-press action sheet (mobile). Lets the user fork the
// thread at the chosen message into a new, independent session — either a
// verbatim "direct" branch or a "summary" branch seeded with an LLM summary
// (with an editable preview before the branch is created). The original
// session is never mutated. See `lib/chat/branch-session.ts`.

import { useId, useState } from "react"
import { useTranslations } from "next-intl"
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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Loader2Icon } from "lucide-react"
import { useChatStore } from "@/stores/chat/chat-store"
import { useProjectStore } from "@/stores/project/project-store"
import { deleteSession, updateSession } from "@/lib/db/sessions"
import {
  readVisibleSessionMessages,
  useConversationSummaryDraft,
} from "@/hooks/chat/use-conversation-summary-draft"
import { ConversationSummaryEditor } from "@/components/chat/conversation-summary-editor"
import {
  branchSessionAtMessage,
  type BranchMode,
  type BranchWorkingSetPolicy,
} from "@/lib/chat/branch-session"
import { surfaceBindingKey } from "@/lib/context-workbench/resource-session"
import { useContextWorkbenchStore } from "@/stores/context-workbench/context-workbench-store"
import { getContextResourceKey } from "@/types/context-workbench"
import type { SessionSurfaceBinding } from "@cognia/agent-config-types"
import { BranchMessagePicker } from "@/components/chat/branch-message-picker"
import { usePlatform } from "@/hooks/use-platform"
import { createLogger } from "@cognia/logging"

const log = createLogger("chat-branch")

/** Broker lease label for the headless fallback — what the runs console shows. */
const SUMMARY_TURN_LABEL = "Branch summary"

/** Where a branch lands: its own conversation, or an aside in the dock. */
type BranchTarget = "session" | "aside"

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
  const isMobile = usePlatform() === "mobile"
  const [mode, setMode] = useState<BranchMode>("direct")
  const [workingSetPolicy, setWorkingSetPolicy] = useState<BranchWorkingSetPolicy>("as-of")
  const workingSetSelectId = useId()
  // Where the branch lands. "session" (default) keeps the existing behaviour;
  // "aside" is the lighter destination for an exploration you expect to fold
  // back, and is desktop-only because the mobile shell mounts no workbench.
  const [target, setTarget] = useState<BranchTarget>("session")
  const summary = useConversationSummaryDraft({
    sessionId,
    turnLabel: SUMMARY_TURN_LABEL,
    onError: (err) => {
      log.error("branch-summary-failed", { sessionId, error: String(err) })
      toast.error(t("summaryError"))
    },
  })
  const summaryText = summary.text
  const generating = summary.generating
  // Cherry-pick. `null` means "everything up to the cut-off" — the default and
  // the pre-existing behaviour; a Set means the user opened the picker and is
  // choosing. Kept out of `mode` because it composes with direct branching
  // rather than replacing it.
  const [picked, setPicked] = useState<Set<string> | null>(null)
  const [creating, setCreating] = useState(false)

  // Reset transient state on close so the next open starts fresh — avoids a
  // setState-in-effect cascade (the desktop toolbar keeps this dialog mounted).
  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setMode("direct")
      setWorkingSetPolicy("as-of")
      setTarget("session")
      setPicked(null)
      summary.reset()
      setCreating(false)
    }
    onOpenChange(next)
  }

  /**
   * The branched session's OWN visible thread.
   *
   * Deliberately keyed off the `sessionId` prop rather than the store's
   * top-level `messages`/`activeBranchByGroup`: those mirror the *active*
   * session only. Both callers already address the message's own session
   * (`message-renderer` resolves `metadata.sessionId`, the mobile action sheet
   * passes `branchTarget.sessionId`), so reading the active projection meant
   * that branching from a split pane or a sidechat looked up the cut-off
   * message in a thread that does not contain it — every such attempt failed
   * with nothing but a generic toast.
   *
   * The active session's slice is materialised lazily, so it can still be
   * missing while the top-level projection is live; fall back to it in that
   * case only.
   */
  const visibleMessages = () => readVisibleSessionMessages(sessionId)

  const keptUpToMessage = () => {
    const visible = visibleMessages()
    const idx = visible.findIndex((m) => m.id === messageId)
    return idx < 0 ? [] : visible.slice(0, idx + 1)
  }

  const generateSummary = () => summary.generate(keptUpToMessage())

  // Auto-generate the first summary when the user switches to summary mode.
  const onModeChange = (next: string) => {
    const m = next as BranchMode
    setMode(m)
    if (m === "summary" && !summaryText && !generating) void generateSummary()
  }

  /**
   * Branch into a new ASIDE rather than a new conversation.
   *
   * Same seed, lighter destination: an exploration you expect to fold back sits
   * in the dock beside the thread it came from and never enters the sidebar,
   * whereas a full branch is a conversation you intend to keep. Reuses the
   * branch machinery wholesale — a branch session is created exactly as before,
   * then converted to an aside bound to the source, so `direct` / `summary` and
   * the SDK-fork optimisation all behave identically.
   */
  const branchIntoAside = async () => {
    const child = await branchSessionAtMessage({
      sourceId: sessionId,
      visibleMessages: visibleMessages(),
      messageId,
      mode,
      summaryText: mode === "summary" ? summaryText : undefined,
      pickedMessageIds: picked ? [...picked] : undefined,
      workingSetPolicy,
    })
    const binding: SessionSurfaceBinding = { kind: "session", sessionId }
    try {
      await updateSession(child.id, {
        kind: "resource-workbench",
        visibility: "embedded",
        surfaceBinding: binding,
        surfaceBindingKey: surfaceBindingKey(binding),
      })
    } catch (error) {
      await deleteSession(child.id)
      throw error
    }
    // Point the workbench at the new aside and bring the dock forward, or the
    // branch lands somewhere the user has to go hunting for.
    useContextWorkbenchStore
      .getState()
      .setSessionOverride(
        getContextResourceKey({ kind: "session", capabilities: ["ai"], sessionId }),
        child.id
      )
    return child
  }

  const onConfirm = async () => {
    if (mode === "summary" && !summaryText.trim()) {
      toast.error(t("summaryEmpty"))
      return
    }
    if (picked && picked.size === 0) {
      toast.error(t("pick.empty"))
      return
    }
    setCreating(true)
    try {
      if (target === "aside") {
        await branchIntoAside()
        toast.success(t("createdAside"))
        handleOpenChange(false)
        return
      }
      const child = await branchSessionAtMessage({
        sourceId: sessionId,
        visibleMessages: visibleMessages(),
        messageId,
        mode,
        summaryText: mode === "summary" ? summaryText : undefined,
        pickedMessageIds: picked ? [...picked] : undefined,
        workingSetPolicy,
      })
      // Link to the active workspace — mirrors the "new conversation" flow
      // (`hooks/chat/use-sessions.ts:create`).
      const { activeProjectId, addSessionToProject } = useProjectStore.getState()
      if (activeProjectId) addSessionToProject(activeProjectId, child.id)

      const store = useChatStore.getState()
      if (isMobile) {
        // No split view on the Capacitor shell — there is only ever one pane, so
        // the branch takes it.
        store.setActiveSession(child.id)
      } else {
        // Open the branch BESIDE its parent rather than navigating away: the
        // point of branching is to try another approach against the original,
        // and the parent may still be running a turn. `chat-pane-group` only
        // renders the split pane for a session that is also open, so the order
        // matters.
        store.openSession(child.id)
        store.setSplitSessionId(child.id)
      }
      toast.success(t("created"))
      handleOpenChange(false)
    } catch (err) {
      log.error("branch-create-failed", { sessionId, messageId, mode, error: String(err) })
      toast.error(
        t(
          err instanceof Error && err.name === "BranchWorkingSetHistoryUnavailableError"
            ? "workingSet.unavailable"
            : "createError"
        )
      )
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
          {/* Destination. Hidden on mobile, which mounts no workbench at all —
              offering "put it in the dock" on a shell with no dock would be a
              choice that silently does nothing. */}
          {!isMobile && (
            <div className="space-y-1.5">
              <Label className="text-xs">{t("target.label")}</Label>
              <RadioGroup
                value={target}
                onValueChange={(v) => setTarget(v as BranchTarget)}
                className="gap-2"
              >
                <label className="flex cursor-pointer items-start gap-3 rounded-md border p-2.5 text-sm">
                  <RadioGroupItem value="session" className="mt-0.5" />
                  <span>
                    <span className="font-medium">{t("target.session")}</span>
                    <span className="text-muted-foreground block text-xs">
                      {t("target.sessionHint")}
                    </span>
                  </span>
                </label>
                <label className="flex cursor-pointer items-start gap-3 rounded-md border p-2.5 text-sm">
                  <RadioGroupItem value="aside" className="mt-0.5" />
                  <span>
                    <span className="font-medium">{t("target.aside")}</span>
                    <span className="text-muted-foreground block text-xs">
                      {t("target.asideHint")}
                    </span>
                  </span>
                </label>
              </RadioGroup>
            </div>
          )}

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

          <div className="space-y-1.5">
            <Label htmlFor={workingSetSelectId} className="text-xs">
              {t("workingSet.label")}
            </Label>
            <NativeSelect
              id={workingSetSelectId}
              value={workingSetPolicy}
              onChange={(event) =>
                setWorkingSetPolicy(event.target.value as BranchWorkingSetPolicy)
              }
              disabled={creating}
              wrapperClassName="w-full"
            >
              <NativeSelectOption value="as-of">{t("workingSet.historical")}</NativeSelectOption>
              <NativeSelectOption value="current">{t("workingSet.current")}</NativeSelectOption>
              <NativeSelectOption value="initial">{t("workingSet.initial")}</NativeSelectOption>
            </NativeSelect>
          </div>

          {mode === "direct" &&
            (picked ? (
              <BranchMessagePicker
                messages={keptUpToMessage()}
                selected={picked}
                onChange={setPicked}
              />
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={() => setPicked(new Set(keptUpToMessage().map((m) => m.id)))}
              >
                {t("pick.open")}
              </Button>
            ))}

          {mode === "summary" && (
            <ConversationSummaryEditor
              label={t("summary.previewLabel")}
              text={summaryText}
              onTextChange={summary.setText}
              generating={generating}
              fallback={summary.fallback}
              onRegenerate={() => void generateSummary()}
            />
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
