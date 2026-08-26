"use client"

// Persistent argument hint for the command the caret is currently editing.
//
// A command's `argumentHint` and `description` used to be visible only inside
// the `/` popover — which closes the moment you pick the command, i.e. exactly
// when you start typing its arguments. This bar keeps them on screen while the
// caret is in the command's argument region, and flags a command whose declared
// `params` have not been supplied (a hint, never a block: the user may be
// mid-keystroke, and commands stay free-form).

import { useTranslations } from "next-intl"
import { InfoIcon, TriangleAlertIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import type { SlashCommand } from "@/lib/slash-commands/builtin"
import type { ComposerTrigger } from "../composer-trigger"

export interface CommandHintBarProps {
  /** Live trigger from `detectTrigger`, or null when no token is active. */
  trigger: ComposerTrigger | null
  /** Name → command lookup (builtin + custom + plugin). */
  commandMap: ReadonlyMap<string, SlashCommand>
  /** Raw input, used to read what the user has typed after the command word. */
  value: string
}

/**
 * Resolve the command whose arguments the caret is in, plus whether its
 * required params are still missing. Exported for direct unit testing — the
 * rendering below is a thin shell over this.
 */
export function resolveCommandHint(
  trigger: ComposerTrigger | null,
  commandMap: ReadonlyMap<string, SlashCommand>,
  value: string
): { command: SlashCommand; missingParams: boolean } | null {
  if (!trigger || trigger.kind !== "slash") return null
  // Only once the caret has moved PAST the command word — while the name is
  // still being typed the popover itself is the affordance. Both argument
  // states qualify: inside the first argument token (`argumentStart` set) and
  // anywhere after it (`caretPastArgument`). The second case used to drop the
  // hint at the second word, which is exactly when a multi-argument command
  // still needs it.
  if (trigger.argumentStart === undefined && !trigger.caretPastArgument) return null
  // `caretPastArgument` says the caret is past the ANCHORED command's first
  // argument — and in a chain the anchor falls back to the line's FIRST
  // command, so the caret may actually be sitting in a later one's arguments.
  // Naming `/clear` while the user types `/clear /resume ▮` is worse than the
  // silence this branch replaced, so stand down whenever another known command
  // follows on the same line.
  if (trigger.argumentStart === undefined && chainedCommandFollows(trigger, commandMap, value)) {
    return null
  }
  const command = commandMap.get(trigger.query)
  if (!command) return null
  const typedArgs = value.slice(trigger.tokenEnd).trim()
  const requiresArgs = (command.params?.length ?? 0) > 0 || Boolean(command.argumentHint)
  return { command, missingParams: requiresArgs && typedArgs.length === 0 }
}

/**
 * Is there another KNOWN `/command` between the anchored one and the end of its
 * line? Bounded to the line because a command on a later line is a separate
 * statement, not a continuation of this one's arguments.
 */
function chainedCommandFollows(
  trigger: ComposerTrigger,
  commandMap: ReadonlyMap<string, SlashCommand>,
  value: string
): boolean {
  const newline = value.indexOf("\n", trigger.tokenEnd)
  const lineEnd = newline === -1 ? value.length : newline
  const rest = value.slice(trigger.tokenEnd, lineEnd)
  return rest.split(/\s+/).some((token) => token.startsWith("/") && commandMap.has(token.slice(1)))
}

export function CommandHintBar({ trigger, commandMap, value }: CommandHintBarProps) {
  const t = useTranslations("chat.composer.commandHint")
  const hint = resolveCommandHint(trigger, commandMap, value)
  if (!hint) return null
  const { command, missingParams } = hint

  return (
    <div
      role="status"
      data-testid="command-hint-bar"
      className={cn(
        "flex items-center gap-1.5 px-2 pt-1 text-[11px]",
        missingParams ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"
      )}
    >
      {missingParams ? (
        <TriangleAlertIcon className="size-3 shrink-0" aria-hidden />
      ) : (
        <InfoIcon className="size-3 shrink-0" aria-hidden />
      )}
      <span className="font-mono font-medium">/{command.name}</span>
      {command.argumentHint ? (
        <span className="font-mono opacity-80">{command.argumentHint}</span>
      ) : null}
      {command.description ? (
        <span className="ml-1 truncate opacity-70">{command.description}</span>
      ) : null}
      {missingParams ? (
        <span className="ml-auto shrink-0 font-medium">{t("needsArgs")}</span>
      ) : null}
    </div>
  )
}
