"use client"

// Ordered, removable pills for the `/commands` staged in the current input.
//
// Multi-command submission has worked for a while (`parseSegments` →
// `runSegments`), but it was invisible: the only hint that `/compact /clear`
// would run two things was the chip overlay painted behind the textarea. This
// bar makes the batch explicit — numbered in execution order, each removable —
// and is also where a failed command from the LAST submit is reported, since
// `runSegments` isolates per-command errors precisely so the rest of the batch
// still runs.
//
// It derives everything from the segment list the composer already computes;
// it never re-parses.

import { useTranslations } from "next-intl"
import { AlertTriangleIcon, XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { InputSegment } from "@/lib/slash-commands/parse-segments"
import type { CommandError } from "@/lib/slash-commands/run-segments"
import { Collapse } from "./collapse"

export interface CommandQueueBarProps {
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

export function CommandQueueBar({ segments, errors = [], onRemove }: CommandQueueBarProps) {
  const t = useTranslations("chat.composer.commandQueue")
  const commands = segments.filter((s) => s.kind === "command")

  // One command is the ordinary case and needs no chrome — the chip overlay
  // already shows it. The bar earns its row only once a BATCH exists, or once
  // something failed and would otherwise be invisible.
  const failed = new Set(errors.map((e) => e.name))
  if (commands.length < 2 && failed.size === 0) return null

  return (
    <Collapse>
      <div
        role="group"
        aria-label={t("ariaLabel")}
        className="flex flex-wrap items-center gap-1.5 px-2 has-[>*]:pt-2"
      >
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {t("label", { count: commands.length })}
        </span>
        {commands.map((cmd, index) => {
          const didFail = failed.has(cmd.name)
          return (
            <div
              key={`${cmd.start}-${cmd.name}`}
              data-testid={`command-queue-pill-${cmd.name}`}
              data-failed={didFail || undefined}
              title={didFail ? t("failedTooltip", { name: cmd.name }) : cmd.raw}
              className={cn(
                "group flex items-center gap-1 rounded-md border px-2 py-1 text-xs",
                didFail
                  ? "border-destructive/50 bg-destructive/10"
                  : "border-primary/30 bg-primary/5"
              )}
            >
              <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                {index + 1}
              </span>
              {didFail ? (
                <AlertTriangleIcon className="size-3.5 text-destructive" aria-hidden />
              ) : null}
              <span className="max-w-[min(200px,calc(100vw-8rem))] truncate font-mono font-medium">
                /{cmd.name}
              </span>
              {cmd.args ? (
                <span className="max-w-[min(160px,40vw)] truncate text-[10px] text-muted-foreground">
                  {cmd.args}
                </span>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t("removeAria", { name: cmd.name })}
                onClick={() => onRemove(cmd.start, cmd.end)}
                className="size-5 opacity-60 transition-opacity hover:opacity-100"
              >
                <XIcon className="size-3" />
              </Button>
            </div>
          )
        })}
      </div>
    </Collapse>
  )
}
