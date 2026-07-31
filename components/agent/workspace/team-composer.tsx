"use client"

/**
 * Team workspace chat composer. Reuses `<Composer>` so we keep all the
 * surrounding affordances (slash trigger, popover positioning, IME, paste
 * / drop, voice transcription, etc.) but flips `mentionMode` to `"agents"`
 * and passes the team's mention candidates so `@` opens the agent picker
 * instead of the file picker.
 *
 * Inputs are passed straight through:
 *   - `onSend(rawText)` — called with the raw textarea content. The
 *     workspace page parses the leading `@<name>` token and routes the
 *     remainder to the right runtime via `dispatchTeamMention`.
 *   - `mentionables` — list of mentionable targets built upstream from the
 *     virtual `@claude` / `@codex` plus all real teammates.
 *
 * Image attachments are not supported in team chat (Phase 1) — the helper
 * extracts text-only content and warns the user when files are dropped.
 */

import { forwardRef, useCallback } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { Loader2Icon, SquareIcon } from "lucide-react"
import { Composer, type ComposerHandle } from "@/components/chat/composer"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { SendContent } from "@cognia/agent-config-types"
import type { AttachmentManifestEntry } from "@/lib/chat/attachments/dispatch"
import type { MentionTarget } from "@/lib/agent-team/runtime-targets"

export interface TeamComposerProps {
  mentionables: readonly MentionTarget[]
  /** Invoked with the raw textarea text. Empty inputs are filtered before this. */
  onSend: (rawText: string) => void | Promise<void>
  onStop?: () => void | Promise<void>
  disabled?: boolean
  /**
   * True while a runtime is streaming a reply for this team. Renders a
   * "Streaming…" banner with a stop button above the composer; the
   * textarea itself stays interactive so the user can queue a follow-up.
   */
  isStreaming?: boolean
  placeholder?: string
}

export const TeamComposer = forwardRef<ComposerHandle, TeamComposerProps>(function TeamComposer(
  { mentionables, onSend, onStop, disabled, isStreaming, placeholder },
  ref
) {
  const t = useTranslations("agentTeamsWorkspace.chat.composer")
  const tStreaming = useTranslations("agentTeamsWorkspace.chat")
  const handleSend = useCallback(
    async (content: SendContent, manifest?: readonly AttachmentManifestEntry[]) => {
      if (manifest?.length) {
        toast.warning(t("attachmentsNotSupported"))
        return
      }
      const text = sendContentToText(content)
      const trimmed = text.trim()
      if (!trimmed) return
      if (Array.isArray(content) && content.some((b) => b.type === "image")) {
        toast.warning(t("imageNotSupported"))
      }
      await onSend(trimmed)
    },
    [onSend, t]
  )

  return (
    <div className="space-y-1.5">
      {isStreaming && (
        <div
          data-testid="team-composer-streaming-banner"
          className={cn(
            "flex items-center gap-2 rounded-md border border-primary/30 bg-primary/5",
            "px-3 py-1.5 text-xs"
          )}
        >
          <Loader2Icon className="size-3 shrink-0 animate-spin text-primary" />
          <span className="flex-1 text-muted-foreground">{tStreaming("streaming")}</span>
          {onStop && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="team-composer-stop"
              onClick={() => void onStop()}
              className="h-6 gap-1 px-2 text-[11px]"
            >
              <SquareIcon className="size-3" />
              {t("stop")}
            </Button>
          )}
        </div>
      )}
      <Composer
        ref={ref}
        onSend={handleSend}
        onStop={onStop ?? (() => undefined)}
        status={isStreaming ? "streaming" : "idle"}
        onStartNewSession={() => undefined}
        onOpenSettings={() => undefined}
        disabled={disabled}
        mentionMode="agents"
        mentionables={mentionables}
        placeholder={placeholder ?? t("placeholder")}
      />
    </div>
  )
})

function sendContentToText(content: SendContent): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  let acc = ""
  for (const block of content) {
    if (block.type === "text") acc += (acc ? "\n" : "") + block.text
  }
  return acc
}
