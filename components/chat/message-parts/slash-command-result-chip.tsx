"use client"

/**
 * SlashCommandResultChip — inline marker rendered alongside a system
 * message that was produced by a `/<command>` Action handler. Tells the
 * user "this is a system response, not the model talking" with the
 * triggering command label visible. Optional summary text replaces the
 * default body.
 *
 * Phase 8 of the ClaudeCode 完整化 plan. Used by the chat composer's
 * `pushSystemMessage(blockOrString)` extension.
 */

import { useTranslations } from "next-intl"
import { TerminalSquareIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"

export interface SlashCommandResultBlock {
  kind: "slash-result"
  /** Name of the command that fired (without the leading `/`). */
  commandId: string
  /** Optional argument string the user typed after the command name. */
  args?: string
  /** Inline summary; falls through to a default i18n message if omitted. */
  summary?: string
}

export function SlashCommandResultChip({ block }: { block: SlashCommandResultBlock }) {
  const t = useTranslations("chat.slashCommand")
  return (
    <span
      className="inline-flex items-center gap-1.5 align-baseline text-xs"
      data-testid="slash-command-result"
      data-command={block.commandId}
    >
      <Badge variant="outline" className="gap-1 border-primary/40 bg-primary/5 text-[10px]">
        <TerminalSquareIcon className="size-3" />/{block.commandId}
        {block.args ? <span className="text-muted-foreground"> {block.args}</span> : null}
      </Badge>
      <span className="text-muted-foreground">{block.summary ?? t("ranSlashCommand")}</span>
    </span>
  )
}
