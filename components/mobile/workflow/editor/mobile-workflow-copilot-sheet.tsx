"use client"

/**
 * Mobile workflow copilot — the touch-first counterpart to the desktop
 * right-sidebar Chat tab. It mounts the SAME `WorkflowEditorChatTab`
 * (session pinning + `useClaudeChat` + `ChatPane` + proposal cards) that the
 * desktop editor uses; only the chrome is mobile-specific: a slide-up sheet
 * over the canvas instead of a resizable column.
 *
 * Transport: the chat tab is transport-agnostic. On Capacitor / web-companion
 * `sendPrompt` routes through the `claude_send` companion RPC to the paired
 * desktop's sidecar, and streamed turns come back over the companion events
 * WebSocket (`claude://message`) — the same channel `useClaudeChat` now
 * subscribes to off-desktop. Proposals surface via `WorkflowProposalCard`,
 * which seeds the phone's local proposal store from the tool-result echo (the
 * desktop's `wf_propose_batch` populated the DESKTOP store, not the phone's).
 *
 * Mount lifecycle: the heavy chat bundle is lazy-loaded on first open, then
 * kept mounted for the rest of the editor session (translated off-screen when
 * the sheet is closed). This mirrors the desktop's `forceMount` + `<Activity>`
 * so closing the sheet mid-stream never drops the live subscription and loses
 * assistant tokens — the conversation keeps persisting to Dexie underneath.
 */

import { Suspense, lazy, useState } from "react"
import { useTranslations } from "next-intl"
import { Loader2Icon, X as CloseIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { useBackDismiss } from "@/hooks/ui/use-back-dismiss"
import { cn } from "@/lib/utils"
import { loadCompanionConfig } from "@/lib/tauri/transport-companion"
import { isTauri } from "@/lib/tauri"
import type { EditorStore } from "@/lib/workflow/editor/store"

const WorkflowEditorChatTab = lazy(() =>
  import("@/components/workflow/editor/right-sidebar/chat-tab").then((m) => ({
    default: m.WorkflowEditorChatTab,
  }))
)

export interface MobileWorkflowCopilotSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  store: EditorStore
  workflowId: string | undefined
  workflowName: string | undefined
}

/**
 * True when a copilot turn can actually reach a sidecar: a paired companion
 * desktop (Capacitor / web-companion have a stored config) or a Tauri host
 * (the mobile editor also renders in a narrow Tauri window). Read once per
 * open — the config only changes via the pairing flow, which navigates away.
 */
function canReachSidecar(): boolean {
  return isTauri() || loadCompanionConfig() != null
}

export function MobileWorkflowCopilotSheet({
  open,
  onOpenChange,
  store,
  workflowId,
  workflowName,
}: MobileWorkflowCopilotSheetProps) {
  const t = useTranslations("mobile.workflow.editor")
  // Lazy-mount on first open, then keep mounted (translate off-screen when
  // closed) so the streamed turn keeps landing even while the sheet is hidden.
  // Render-phase latch (no effect): once `open` has been true, stay `true`.
  const [everOpened, setEverOpened] = useState(open)
  if (open && !everOpened) setEverOpened(true)

  const reachable = canReachSidecar()

  // Close on Android hardware / browser back while open (shared history
  // push/pop convention — see hooks/ui/use-back-dismiss.ts).
  useBackDismiss(open, () => onOpenChange(false))

  return (
    <>
      {/* Scrim — only interactive while open. */}
      <button
        type="button"
        aria-hidden={!open}
        tabIndex={-1}
        onClick={() => onOpenChange(false)}
        className={cn(
          "fixed inset-0 z-40 bg-black/40 transition-opacity duration-200",
          open ? "opacity-100" : "pointer-events-none opacity-0"
        )}
        data-testid="mobile-copilot-scrim"
      />
      <section
        role="dialog"
        aria-modal={open}
        aria-label={t("copilotTitle")}
        aria-hidden={!open}
        className={cn(
          "fixed inset-x-0 bottom-0 z-50 flex h-[88vh] flex-col rounded-t-2xl border-t bg-background shadow-2xl transition-transform duration-300 ease-out",
          open ? "translate-y-0" : "pointer-events-none translate-y-full"
        )}
        data-testid="mobile-copilot-sheet"
        data-state={open ? "open" : "closed"}
      >
        <header className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2">
          <div className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="h-1 w-8 rounded-full bg-muted-foreground/30"
            />
            <h2 className="text-sm font-semibold">{t("copilotTitle")}</h2>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-9"
            onClick={() => onOpenChange(false)}
            aria-label={t("copilotClose")}
            data-testid="mobile-copilot-close"
          >
            <CloseIcon className="size-5" aria-hidden="true" />
          </Button>
        </header>

        <div className="min-h-0 flex-1 overflow-hidden">
          {!reachable ? (
            <div
              className="flex h-full w-full items-center justify-center p-6 text-center text-sm text-muted-foreground"
              data-testid="mobile-copilot-offline"
            >
              {t("copilotOffline")}
            </div>
          ) : everOpened ? (
            <Suspense
              fallback={
                <div
                  className="flex h-full w-full items-center justify-center gap-2 p-6 text-sm text-muted-foreground"
                  data-testid="mobile-copilot-loading"
                >
                  <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
                </div>
              }
            >
              <WorkflowEditorChatTab
                useStore={store}
                workflowId={workflowId}
                workflowName={workflowName}
              />
            </Suspense>
          ) : null}
        </div>
      </section>
    </>
  )
}
