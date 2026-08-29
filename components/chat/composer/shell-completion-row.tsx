"use client"

/**
 * One `!`-mode completion candidate, rendered inside the composer popover.
 *
 * The kind badge is the point of this row. A shell prompt gives you an
 * undifferentiated column of words; here `grep` (a real executable on the Host)
 * and `grep` (a name the in-repo spec knows about) and `grep.txt` (a file that
 * happens to match) are visibly three different answers — which matters most on
 * a client with no Host, where the filesystem rows are simply absent and the
 * user would otherwise be left guessing why.
 */

import {
  ChevronRightIcon,
  FileIcon,
  FolderIcon,
  SlidersHorizontalIcon,
  SquareTerminalIcon,
  TerminalIcon,
} from "lucide-react"
import { useTranslations } from "next-intl"

import type { ShellCompletion } from "@/lib/shell-intelligence/types"
import { cn } from "@/lib/utils"

/**
 * Kind → message key, written out rather than interpolated.
 *
 * `lint:i18n` cannot see through a computed key, so a template would leave
 * these six strings unchecked in both locales. The pinning test beside this
 * file walks the map instead.
 */
export const SHELL_KIND_LABEL_KEYS: Record<ShellCompletion["kind"], string> = {
  command: "shell.commandKind",
  builtin: "shell.builtinKind",
  path: "shell.pathKind",
  directory: "shell.directoryKind",
  option: "shell.optionKind",
  argument: "shell.argumentKind",
}

function KindIcon({ kind }: { kind: ShellCompletion["kind"] }) {
  const className = "size-4"
  switch (kind) {
    case "builtin":
      return <SquareTerminalIcon className={className} />
    case "command":
      return <TerminalIcon className={className} />
    case "directory":
      return <FolderIcon className={className} />
    case "path":
      return <FileIcon className={className} />
    case "option":
      return <SlidersHorizontalIcon className={className} />
    case "argument":
      return <ChevronRightIcon className={className} />
  }
}

export function ShellCompletionRow({ completion }: { completion: ShellCompletion }) {
  const t = useTranslations("chat.composer.popover")
  return (
    <>
      <span
        className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted/70 text-muted-foreground transition-colors group-data-[active=true]/row:bg-background/70 group-data-[active=true]/row:text-foreground motion-reduce:transition-none"
        data-shell-kind={completion.kind}
      >
        <KindIcon kind={completion.kind} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-mono text-sm">{completion.label}</span>
        {completion.detail ? (
          <span className="truncate text-xs text-muted-foreground">{completion.detail}</span>
        ) : null}
      </span>
      <span
        className={cn(
          "shrink-0 rounded-md bg-muted/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wide",
          "text-muted-foreground"
        )}
      >
        {t(SHELL_KIND_LABEL_KEYS[completion.kind])}
      </span>
    </>
  )
}
