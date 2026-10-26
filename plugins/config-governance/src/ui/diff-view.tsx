"use client"

import { cn } from "@cognia/plugin-ui"

import type { DiffLine } from "../engine/diff"

/** A unified diff of one hunk, line-numbered. */
export function DiffView({ lines, label }: { lines: readonly DiffLine[]; label: string }) {
  return (
    <pre
      aria-label={label}
      className="max-h-64 overflow-auto rounded-md border bg-muted/30 p-2 font-mono text-[11px] leading-relaxed"
      data-testid="governance-diff"
    >
      {lines.map((line, index) => (
        <div
          key={`${line.kind}-${line.line}-${index}`}
          className={cn(
            "flex gap-2 whitespace-pre-wrap break-words",
            line.kind === "removed" && "bg-red-500/10 text-red-700 dark:text-red-300",
            line.kind === "added" && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
          )}
          data-kind={line.kind}
        >
          <span className="w-8 shrink-0 select-none text-right text-muted-foreground">
            {line.line}
          </span>
          <span className="w-3 shrink-0 select-none">
            {line.kind === "removed" ? "−" : line.kind === "added" ? "+" : " "}
          </span>
          <span className="min-w-0 flex-1">{line.text || " "}</span>
        </div>
      ))}
    </pre>
  )
}
