"use client"

// Inline popover anchored above the chat composer textarea. Renders one of
// three lists depending on the trigger kind: slash command, file/folder, or
// memory scope picker. Bash mode renders a single informational row.
//
// The composer keeps the textarea focused at all times, so this component
// exposes an imperative ref (`navigate`, `confirm`) that the composer's
// onKeyDown handler calls in response to ArrowUp/Down/Enter/Tab/Escape.
// Mouse interactions (click) work through the regular onMouseDown/onClick
// handlers.

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { FileIcon, FolderIcon, SlashIcon, TerminalIcon, BookMarkedIcon } from "lucide-react"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import { searchWorkspace } from "@/lib/files/workspace-search"
import type { WorkspaceEntry } from "@/lib/files/types"
import type { SlashCommand } from "@/lib/slash-commands/builtin"
import { cn } from "@/lib/utils"
import { loggers } from "@/lib/logger"

import type { ComposerTrigger, TriggerKind } from "./composer-trigger"

export type PopoverItem =
  | { kind: "slash"; command: SlashCommand }
  | { kind: "file"; entry: WorkspaceEntry }
  | { kind: "memory"; scope: "project" | "user"; preview: string }

export interface ComposerPopoverHandle {
  /** Move the highlighted index by `delta` (-1 for up, +1 for down). */
  navigate: (delta: number) => void
  /** Confirm the highlighted item — returns true if a pick happened. */
  confirm: () => boolean
}

interface Props {
  /** When null, the popover is closed. */
  trigger: ComposerTrigger | null
  /** Workspace root for the @file search. Required for file mode to work. */
  cwd: string | null | undefined
  /** Slash commands available right now (built-in + scanned custom). */
  slashCommands: SlashCommand[]
  /** Anchor element — typically the composer container. */
  anchor: HTMLElement | null
  /** Called when the user picks an item. */
  onPick: (item: PopoverItem) => void
  /** Called when the user dismisses the popover (Escape / outside click). */
  onDismiss: () => void
}

interface ItemList {
  items: PopoverItem[]
  loading: boolean
  error: string | null
  emptyMessage: string
}

export const ComposerPopover = forwardRef<ComposerPopoverHandle, Props>(function ComposerPopover(
  { trigger, cwd, slashCommands, anchor, onPick, onDismiss },
  ref
) {
  const t = useTranslations("chat.composer.popover")
  const tMemory = useTranslations("chat.composer.memory")
  const [highlight, setHighlight] = useState(0)
  // The async file-search produces an `ItemList` over time; for slash, memory
  // and bash kinds we derive the list synchronously below. The combined view
  // is `displayList`.
  const [fileList, setFileList] = useState<ItemList | null>(null)

  // Reset highlight to 0 every time a new trigger opens. The state lives in
  // React because the user can navigate it; resetting it is a legit
  // side-effect of the trigger identity changing.
  const triggerKind = trigger?.kind
  const triggerStart = trigger?.tokenStart
  useEffect(() => {
    if (triggerKind !== undefined) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setHighlight(0)
    }
  }, [triggerKind, triggerStart])

  // File mode: debounced workspace search (the only async kind). All
  // setState calls below are intentional async boundaries — eslint's
  // set-state-in-effect rule guards against using effects to mirror state,
  // which isn't what's happening here.
  const lastQueryRef = useRef<string>("")
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!trigger || trigger.kind !== "file") {
      setFileList(null)
      return
    }
    if (!cwd) {
      setFileList({
        items: [],
        loading: false,
        error: t("workspaceMissing"),
        emptyMessage: "",
      })
      return
    }
    const q = trigger.query
    lastQueryRef.current = q
    setFileList({ items: [], loading: true, error: null, emptyMessage: "" })
    const handle = window.setTimeout(() => {
      searchWorkspace(cwd, q, 50)
        .then((entries) => {
          if (lastQueryRef.current !== q) return
          setFileList({
            items: entries.map((entry) => ({ kind: "file" as const, entry })),
            loading: false,
            error: null,
            emptyMessage: q ? t("noFiles", { query: q }) : t("workspaceEmpty"),
          })
        })
        .catch((err) => {
          if (lastQueryRef.current !== q) return
          loggers.chat.warn("composer file search failed", {
            err: err instanceof Error ? err.message : String(err),
            cwd,
            query: q,
          })
          setFileList({
            items: [],
            loading: false,
            error: err instanceof Error ? err.message : String(err),
            emptyMessage: "",
          })
        })
    }, 200)
    return () => window.clearTimeout(handle)
  }, [trigger, cwd, t])
  /* eslint-enable react-hooks/set-state-in-effect */

  const displayList: ItemList = useMemo(() => {
    if (!trigger) {
      return { items: [], loading: false, error: null, emptyMessage: "" }
    }
    if (trigger.kind === "slash") {
      const q = trigger.query.toLowerCase()
      const items: PopoverItem[] = slashCommands
        .filter((c) => !q || c.name.toLowerCase().includes(q))
        .map((command) => ({ kind: "slash" as const, command }))
      return {
        items,
        loading: false,
        error: null,
        emptyMessage:
          slashCommands.length === 0
            ? t("noCommands")
            : t("noCommandMatches", { query: trigger.query }),
      }
    }
    if (trigger.kind === "memory") {
      const preview = trigger.query.trim() || tMemory("emptyPreview")
      return {
        items: [
          { kind: "memory", scope: "project", preview },
          { kind: "memory", scope: "user", preview },
        ],
        loading: false,
        error: null,
        emptyMessage: "",
      }
    }
    if (trigger.kind === "bash") {
      return { items: [], loading: false, error: null, emptyMessage: "" }
    }
    // file
    return (
      fileList ?? {
        items: [],
        loading: true,
        error: null,
        emptyMessage: "",
      }
    )
  }, [trigger, slashCommands, fileList, t, tMemory])

  // Clamp the highlight whenever the visible list shrinks below it. The
  // updater form means the clamp is idempotent if it fires multiple times.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHighlight((h) =>
      displayList.items.length === 0 ? 0 : Math.min(Math.max(h, 0), displayList.items.length - 1)
    )
  }, [displayList.items.length])

  useImperativeHandle(
    ref,
    () => ({
      navigate: (delta) => {
        setHighlight((h) => {
          if (displayList.items.length === 0) return h
          const next = (h + delta + displayList.items.length) % displayList.items.length
          return next
        })
      },
      confirm: () => {
        const item = displayList.items[highlight]
        if (!item) return false
        onPick(item)
        return true
      },
    }),
    [displayList.items, highlight, onPick]
  )

  const open = trigger !== null && anchor !== null
  const title = useMemo(() => triggerTitle(trigger?.kind, t), [trigger?.kind, t])

  return (
    <Popover open={open} onOpenChange={(v) => (!v ? onDismiss() : undefined)}>
      {anchor ? <PopoverAnchor virtualRef={{ current: anchor }} /> : null}
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-[480px] max-w-[90vw] p-0"
        // Don't steal focus from the textarea.
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <div className="flex items-center gap-2 border-b px-3 py-2 text-xs text-muted-foreground">
          {title.icon}
          <span className="flex-1 truncate">{title.label}</span>
          {displayList.loading ? <span>{t("searchingShort")}</span> : null}
        </div>
        {trigger?.kind === "bash" ? (
          <BashHint query={trigger.query} />
        ) : displayList.error ? (
          <div className="px-3 py-3 text-sm text-destructive">{displayList.error}</div>
        ) : displayList.items.length === 0 ? (
          <div className="px-3 py-3 text-sm text-muted-foreground">
            {displayList.loading ? t("searching") : displayList.emptyMessage}
          </div>
        ) : (
          <ul className="max-h-72 overflow-auto py-1">
            {displayList.items.map((item, idx) => (
              <li
                key={itemKey(item, idx)}
                className={cn(
                  "flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm",
                  idx === highlight ? "bg-accent text-accent-foreground" : "hover:bg-accent/40"
                )}
                onMouseEnter={() => setHighlight(idx)}
                onMouseDown={(e) => {
                  // Prevent the textarea blur that would otherwise fire.
                  e.preventDefault()
                  onPick(item)
                }}
              >
                <ItemRow item={item} />
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  )
})

function triggerTitle(
  kind: TriggerKind | undefined,
  t: (key: string) => string
): {
  icon: React.ReactNode
  label: string
} {
  switch (kind) {
    case "slash":
      return { icon: <SlashIcon className="size-3.5" />, label: t("slashTitle") }
    case "file":
      return { icon: <FileIcon className="size-3.5" />, label: t("fileTitle") }
    case "memory":
      return {
        icon: <BookMarkedIcon className="size-3.5" />,
        label: t("memoryTitle"),
      }
    case "bash":
      return { icon: <TerminalIcon className="size-3.5" />, label: t("bashTitle") }
    default:
      return { icon: null, label: "" }
  }
}

function itemKey(item: PopoverItem, idx: number): string {
  if (item.kind === "slash") return `slash-${item.command.name}`
  if (item.kind === "file") return `file-${item.entry.absolutePath}`
  if (item.kind === "memory") return `memory-${item.scope}`
  return `idx-${idx}`
}

function ItemRow({ item }: { item: PopoverItem }) {
  const t = useTranslations("chat.composer.popover")
  const tMemory = useTranslations("chat.composer.memory")
  if (item.kind === "slash") {
    const c = item.command
    return (
      <>
        <SlashIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className={cn("font-mono text-xs", c.disabled && "opacity-60")}>/{c.name}</span>
        {c.argumentHint ? (
          <span className="text-xs text-muted-foreground">{c.argumentHint}</span>
        ) : null}
        <span
          className={cn("ml-auto truncate text-xs text-muted-foreground", c.disabled && "italic")}
        >
          {c.disabled ? t("comingSoon") : c.description}
        </span>
        <span className="rounded border px-1 text-[10px] text-muted-foreground">{c.scope}</span>
      </>
    )
  }
  if (item.kind === "file") {
    const e = item.entry
    return (
      <>
        {e.isDir ? (
          <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <FileIcon className="size-4 shrink-0 text-muted-foreground" />
        )}
        <span className="truncate font-mono text-xs">{e.relPath}</span>
        {!e.isDir && e.size > 0 ? (
          <span className="ml-auto text-[10px] text-muted-foreground">{formatBytes(e.size)}</span>
        ) : null}
      </>
    )
  }
  if (item.kind === "memory") {
    return (
      <>
        <BookMarkedIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="font-medium">
          {item.scope === "project" ? tMemory("projectLabel") : tMemory("userLabel")}
        </span>
        <span className="ml-auto truncate text-xs text-muted-foreground">{item.preview}</span>
      </>
    )
  }
  return null
}

function BashHint({ query }: { query: string }) {
  const t = useTranslations("chat.composer.popover")
  return (
    <div className="px-3 py-3 text-sm text-muted-foreground">
      <p className="mb-1">
        {t("bashHintPrefix")} <kbd>Enter</kbd> {t("bashHintSuffix")}
      </p>
      <code className="block truncate rounded bg-muted px-2 py-1 font-mono text-xs">
        $ {query || t("bashEmpty")}
      </code>
    </div>
  )
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
