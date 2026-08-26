"use client"

// The one thing a `/command` cannot say for itself: that it FAILED.
//
// `runSegments` isolates per-command errors precisely so the rest of a batch
// still runs — which means a failure inside `/compact /clear` would otherwise
// be completely silent. The staged commands themselves need no chip: each one
// is already a pill on its own token in the text. Only the failures surface
// here, as removable pills that name the command that broke.
//
// They render as a bare fragment, not as a band of their own — they join the
// single context row in `ContextChipBar`, which owns the spacing and the fold.
// Everything is derived from the segment list the composer already computes;
// nothing is re-parsed here.

import { Fragment } from "react"
import { useTranslations } from "next-intl"
import { AlertTriangleIcon, XIcon } from "lucide-react"
import {
  QueueItemAction,
  QueueItemActions,
  QueueItemIndicator,
} from "@/components/ai-elements/queue"
import { cn } from "@/lib/utils"
import type { InputSegment } from "@/lib/slash-commands/parse-segments"
import type { CommandError } from "@/lib/slash-commands/run-segments"

export interface FailedCommandChipsProps {
  /** Parsed segments for the live input (the composer's existing memo). */
  segments: readonly InputSegment[]
  /** Per-command failures from the most recent submit. */
  errors?: readonly CommandError[]
  /**
   * Remove the command occupying `[start, end)` of the raw input. The composer
   * splices the range out, which is why the absolute indices matter.
   */
  onRemove: (start: number, end: number) => void
}

/**
 * Pin each failure onto exactly ONE command occurrence.
 *
 * A name is not an identity: `/model opus /model sonnet` is two occurrences of
 * one name, so matching by name alone painted a chip on both when only one had
 * failed — and then numbered one of them wrong, which is the whole point of
 * showing a position. `runSegments` reports the occurrence it actually ran, and
 * that is used first. The fallback covers a batch parsed from a SLICE of the
 * text (a first-line `!`/`#` mode, or a parameter substitution re-parse), where
 * ordinals shift: claim the first same-named command no other failure holds, so
 * the count stays right and no command is ever chipped twice.
 */
function resolveFailures(
  commands: readonly Extract<InputSegment, { kind: "command" }>[],
  errors: readonly CommandError[]
): Map<number, CommandError> {
  const byIndex = new Map<number, CommandError>()
  for (const error of errors) {
    const reported = error.occurrence
    if (
      reported !== undefined &&
      commands[reported]?.name === error.name &&
      !byIndex.has(reported)
    ) {
      byIndex.set(reported, error)
      continue
    }
    const fallback = commands.findIndex(
      (command, index) => command.name === error.name && !byIndex.has(index)
    )
    if (fallback >= 0) byIndex.set(fallback, error)
  }
  return byIndex
}

export function FailedCommandChips({ segments, errors = [], onRemove }: FailedCommandChipsProps) {
  const t = useTranslations("chat.composer.commandQueue")
  // Position in the batch is still worth showing — "the second one failed" is
  // the difference between re-running everything and re-running one thing.
  const commands = segments.filter((s) => s.kind === "command")
  const failed = resolveFailures(commands, errors)
  if (failed.size === 0) return null

  return (
    <Fragment>
      {commands.map((cmd, index) => {
        // Every row that reaches the DOM is a failure — the guard above returns
        // early when nothing failed, and this one skips the commands that ran.
        // There is no second chip state to branch on.
        if (!failed.has(index)) return null
        return (
          <div
            key={`${cmd.start}-${cmd.name}`}
            data-testid={`failed-command-pill-${cmd.name}`}
            data-failed
            title={t("failedTooltip", { name: cmd.name })}
            className={cn(
              "group flex h-7 flex-row items-center gap-1 rounded-md border px-2 text-xs",
              "border-destructive/50 bg-destructive/10"
            )}
          >
            <QueueItemIndicator className="border-destructive bg-destructive" />
            <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
              {index + 1}
            </span>
            <AlertTriangleIcon className="size-3.5 text-destructive" aria-hidden />
            <span className="max-w-[min(200px,calc(100vw-8rem))] truncate font-mono font-medium text-foreground">
              /{cmd.name}
            </span>
            {cmd.args ? (
              <span className="max-w-[min(160px,40vw)] truncate text-[10px] text-muted-foreground">
                {cmd.args}
              </span>
            ) : null}
            <QueueItemActions>
              <QueueItemAction
                aria-label={t("removeAria", { name: cmd.name })}
                onClick={() => onRemove(cmd.start, cmd.end)}
                className="size-5 opacity-60 hover:opacity-100"
              >
                <XIcon className="size-3" />
              </QueueItemAction>
            </QueueItemActions>
          </div>
        )
      })}
    </Fragment>
  )
}
