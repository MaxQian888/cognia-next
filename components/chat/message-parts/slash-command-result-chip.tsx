"use client"

/**
 * SlashCommandResultChip — inline marker rendered alongside a system
 * message that was produced by a `/<command>` Action handler. Tells the
 * user "this is a system response, not the model talking" with the
 * triggering command label visible. Optional summary text replaces the
 * default body.
 *
 * Emitted by slash actions via `ctx.pushSystemMessage({ kind: "slash-result",
 * … })` (see `lib/slash-commands/system-blocks.ts`); the chat message renderer
 * dispatches the carrying `data-diagnostics` part here on `kind`.
 */

import { useTranslations } from "next-intl"
import { TerminalSquareIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import type { SlashCommandResultBlock } from "@/lib/slash-commands/system-blocks"

export type { SlashCommandResultBlock }

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
