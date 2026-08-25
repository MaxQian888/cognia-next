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

import {
  useCallback,
  useDeferredValue,
  forwardRef,
  Fragment,
  memo,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react"
import { useTranslations } from "next-intl"
import {
  ActivityIcon,
  AtSignIcon,
  BlocksIcon,
  BookMarkedIcon,
  BoxIcon,
  CloudIcon,
  BrainIcon,
  CircleHelpIcon,
  CornerDownRightIcon,
  FileCode2Icon,
  FileIcon,
  FolderIcon,
  ListPlusIcon,
  MessageCircleMoreIcon,
  PinIcon,
  PinOffIcon,
  Repeat2Icon,
  SearchIcon,
  SearchXIcon,
  Settings2Icon,
  SparklesIcon,
  SplineIcon,
  SheetIcon,
  SquareTerminalIcon,
  TableIcon,
  TargetIcon,
  TerminalIcon,
  WandSparklesIcon,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Kbd, KbdGroup } from "@/components/ui/kbd"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { searchWorkspace } from "@/lib/files/workspace-search"
import { useRemoteDocSearch } from "@/hooks/chat/use-remote-doc-search"
import type { RemoteDocRef } from "@/lib/docs-providers"
import type { WorkspaceEntry } from "@/lib/files/types"
import type { SlashCommand } from "@/lib/slash-commands/builtin"
import type { SystemPromptPreset } from "@cognia/agent-config-types"
import type { SkillMentionTarget } from "@/hooks/chat/use-mentionable-skills"
import { fuzzyFilterSort, fuzzyFilterSortRanked } from "@/lib/chat/completion/fuzzy-match"
import { MatchHighlight } from "@/components/chat/completion/match-highlight"
import {
  orderedCommandsForEmptyQuery,
  slashGroupLabel,
  type SlashGroup,
} from "./composer-popover-groups"
import { cn } from "@/lib/utils"
import {
  COMPOSER_MEMORY_TARGETS,
  isMemoryTargetAvailable,
  memoryTargetKey,
  type ComposerMemoryTarget,
} from "@/lib/chat/memory-target"
import { usePlatform } from "@/hooks/use-platform"
import { loggers } from "@cognia/logging"
import {
  AgentMentionRow,
  SubagentMentionRow,
  filterMentionables,
  filterSubagents,
} from "@/components/agent/workspace/agent-mention-picker"
import type { MentionTarget } from "@/lib/agent-team/runtime-targets"
import type { SubagentMentionTarget } from "@/lib/claude/agents/chat-mention-targets"

import type { ComposerTrigger, MentionableWorkflowElement, TriggerKind } from "./composer-trigger"
import type { ChatTemplateRow } from "@/lib/db/chat-templates"

export type PopoverItem =
  | {
      kind: "slash"
      command: SlashCommand
      /** Matched indices in the command name (non-empty query only). */
      positions?: number[]
      /** Section tag for the empty-query grouped view. */
      group?: SlashGroup
    }
  | {
      kind: "slashArgument"
      command: SlashCommand
      value: string
      replaceStart: number
      replaceEnd: number
    }
  | { kind: "file"; entry: WorkspaceEntry }
  | {
      kind: "memory"
      target: ComposerMemoryTarget
      preview: string
      /** False when the shell can't perform this write (file scopes off desktop). */
      available: boolean
    }
  | { kind: "agent"; target: MentionTarget }
  | { kind: "subagent"; target: SubagentMentionTarget }
  | { kind: "skill"; skill: SkillMentionTarget }
  | { kind: "preset"; preset: SystemPromptPreset }
  /**
   * A saved chat template. Its own kind rather than a projected `SlashCommand`
   * on purpose: a command's body goes through `applyTemplate`, whose `$1` /
   * `$ARGUMENTS` pass would eat a literal `$1` in a template body. The two
   * argument syntaxes are deliberately kept from crossing.
   */
  | { kind: "chatTemplate"; template: ChatTemplateRow }
  | { kind: "wfElement"; element: MentionableWorkflowElement }
  | {
      kind: "doc"
      /** Owning `DocsProvider.id`, so the pick handler can resolve the fetcher. */
      providerId: string
      /** Account the fetch must run as. */
      accountId: string
      doc: RemoteDocRef
    }

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
  /**
   * Mentionable agents for the agent picker. Required when the composer's
   * `mentionMode` is `"agents"`. Empty in file mode.
   */
  mentionables?: readonly MentionTarget[]
  /**
   * Subagents mentionable in the GENERAL chat composer (combined `@` mode).
   * When non-empty, the `@file` panel prepends an "Agents" section with these,
   * above the workspace file results. Empty / undefined in file-only or
   * team (`mentionMode="agents"`) composers.
   */
  chatAgents?: readonly SubagentMentionTarget[]
  /**
   * Enabled skills surfaced by the `@skill:` namespaced mention. Picking one
   * ENABLES it for the session (no text inserted) — see `composer.tsx`'s
   * `onPickPopoverItem`. Empty / undefined outside the general chat composer.
   */
  chatSkills?: readonly SkillMentionTarget[]
  /**
   * Prompt presets surfaced by the `@preset:` namespaced mention. Picking one
   * APPLIES it to the active session (system prompt + model + … ; no text
   * inserted). Empty / undefined outside the general chat composer.
   */
  chatPresets?: readonly SystemPromptPreset[]
  /**
   * Workflow graph elements surfaced by the workflow composer's `@` / `@node:`
   * / `@edge:` mentions. Picking one stages a reference chip (no text inserted)
   * — see `composer.tsx`'s `onPickPopoverItem`. Empty / undefined outside the
   * workflow-editor composer.
   */
  workflowElements?: readonly MentionableWorkflowElement[]
  /**
   * Fired when the highlighted row changes to (or away from) a workflow
   * element — the workflow composer maps this to a transient canvas highlight
   * so arrowing through the picker pulses the matching node.
   */
  onHighlightElement?: (element: MentionableWorkflowElement | null) => void
  /** Recently-used command names (newest first) for the empty-query view. */
  recentCommands?: readonly string[]
  /** Pinned command names (pin order) for the empty-query view + pin toggles. */
  pinnedCommands?: readonly string[]
  /** Toggle a command's pinned state from a row's pin button. */
  onTogglePin?: (name: string) => void
  /** Called when the user picks an item. */
  /** Saved chat templates, offered in their own section of the `/` menu. */
  chatTemplates?: ChatTemplateRow[]
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
  {
    trigger,
    cwd,
    slashCommands,
    anchor,
    mentionables,
    chatAgents,
    chatSkills,
    chatPresets,
    chatTemplates,
    workflowElements,
    onHighlightElement,
    recentCommands,
    pinnedCommands,
    onTogglePin,
    onPick,
    onDismiss,
  },
  ref
) {
  const t = useTranslations("chat.composer.popover")
  const tMemory = useTranslations("chat.composer.memory")
  const tAgent = useTranslations("agentTeamsWorkspace.chat.composer")
  const tDocs = useTranslations("docsProviders")

  // Remote documents (`@lark:` / `@gdoc:`). The hook is called unconditionally
  // — it no-ops with a null namespace — because hooks cannot be conditional and
  // the trigger kind changes on every keystroke.
  const docSearch = useRemoteDocSearch({
    namespace: trigger?.kind === "doc" ? (trigger.namespace ?? null) : null,
    query: trigger?.kind === "doc" ? trigger.query : "",
  })
  // File-scoped memory writes go through a Tauri command, so the two CLAUDE.md
  // rows are inert off the desktop shell.
  const isDesktop = usePlatform() === "tauri"
  const [highlight, setHighlight] = useState(0)
  const [slashSearch, setSlashSearch] = useState<string | null>(null)
  const listRef = useRef<HTMLUListElement>(null)
  // The async file-search produces an `ItemList` over time; for slash, memory
  // and bash kinds we derive the list synchronously below. The combined view
  // is `displayList`.
  const [fileList, setFileList] = useState<ItemList | null>(null)

  // Reset highlight to 0 every time a new trigger opens. The state lives in
  // React because the user can navigate it; resetting it is a legit
  // side-effect of the trigger identity changing.
  const triggerKind = trigger?.kind
  const triggerStart = trigger?.tokenStart
  const slashQuery =
    trigger?.kind === "slash" ? (slashSearch ?? trigger.argumentQuery ?? trigger.query) : ""
  const deferredSlashQuery = useDeferredValue(slashQuery)
  useEffect(() => {
    if (triggerKind !== undefined) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setHighlight(0)
      setSlashSearch(null)
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
      const query = deferredSlashQuery.trim()
      const command = slashCommands.find((candidate) => candidate.name === trigger.query)
      const argumentOptions = commandArgumentOptions(command)
      if (
        command &&
        argumentOptions.length > 0 &&
        trigger.argumentQuery !== undefined &&
        trigger.argumentStart !== undefined &&
        trigger.argumentEnd !== undefined
      ) {
        // Argument option sets are intentionally tiny and selection correctness
        // matters more than deferral here: a quick "p" → Enter must never
        // confirm an option from the previous empty-query frame.
        const items = fuzzyFilterSort(argumentOptions, slashQuery, (value) => value).map(
          (value) => ({
            kind: "slashArgument" as const,
            command,
            value,
            replaceStart: trigger.argumentStart as number,
            replaceEnd: trigger.argumentEnd as number,
          })
        )
        return {
          items,
          loading: false,
          error: null,
          emptyMessage: t("noArgumentMatches", { query: slashQuery }),
        }
      }
      // Empty query → grouped view: Pinned → Recent → per-category, each with a
      // section header. Non-empty → flat fuzzy-ranked list with matched-char
      // highlight (ranking wins; grouping would fight the relevance order).
      const commandItems: PopoverItem[] =
        query === ""
          ? orderedCommandsForEmptyQuery(
              slashCommands,
              recentCommands ?? [],
              pinnedCommands ?? []
            ).map(({ command, group }) => ({ kind: "slash" as const, command, group }))
          : fuzzyFilterSortRanked(slashCommands, deferredSlashQuery, (c) => c.name, {
              secondaryText: (c) => c.description,
            }).map(({ item, positions }) => ({
              kind: "slash" as const,
              command: item,
              positions,
            }))
      // Templates come last and always as their own block, never interleaved
      // with commands: picking one INSERTS a message body, where picking a
      // command drops `/name` in for you to review. Two different outcomes from
      // one list is exactly the sort of thing that gets clicked by mistake.
      const templateItems: PopoverItem[] = (chatTemplates ?? [])
        .filter(
          (template) =>
            query === "" ||
            template.name.toLocaleLowerCase().includes(deferredSlashQuery.toLocaleLowerCase())
        )
        .map((template) => ({ kind: "chatTemplate" as const, template }))
      const items: PopoverItem[] = [...commandItems, ...templateItems]
      return {
        items,
        loading: false,
        error: null,
        emptyMessage:
          slashCommands.length === 0
            ? t("noCommands")
            : t("noCommandMatches", { query: deferredSlashQuery }),
      }
    }
    if (trigger.kind === "memory") {
      const preview = trigger.query.trim() || tMemory("emptyPreview")
      // Four destinations: the two ADR-0069 long-term store scopes (all
      // platforms) then the two CLAUDE.md file scopes (desktop only). `#` used
      // to reach only the files, so there was no way to put a fact where
      // `/remember` puts it and `/memory list` reads it.
      return {
        items: COMPOSER_MEMORY_TARGETS.map((target) => ({
          kind: "memory" as const,
          target,
          preview,
          available: isMemoryTargetAvailable(target, isDesktop),
        })),
        loading: false,
        error: null,
        emptyMessage: "",
      }
    }
    if (trigger.kind === "bash") {
      return { items: [], loading: false, error: null, emptyMessage: "" }
    }
    if (trigger.kind === "agent") {
      const list = mentionables ?? []
      const filtered = filterMentionables(list, trigger.query)
      return {
        items: filtered.map((target) => ({ kind: "agent" as const, target })),
        loading: false,
        error: null,
        emptyMessage:
          list.length === 0
            ? safeLookup(tAgent, "noAgents", "No agents available")
            : safeLookup(tAgent, "noMatches", `No agent matches "${trigger.query}"`, {
                query: trigger.query,
              }),
      }
    }
    if (trigger.kind === "skill") {
      const list = chatSkills ?? []
      const filtered = fuzzyFilterSort(list, trigger.query, (s) => s.name, {
        secondaryText: (s) => s.description ?? "",
      })
      return {
        items: filtered.map((skill) => ({ kind: "skill" as const, skill })),
        loading: false,
        error: null,
        emptyMessage:
          list.length === 0 ? t("noSkills") : t("noSkillMatches", { query: trigger.query }),
      }
    }
    if (trigger.kind === "preset") {
      const list = chatPresets ?? []
      const filtered = fuzzyFilterSort(list, trigger.query, (p) => p.name, {
        secondaryText: (p) => p.description ?? "",
      })
      return {
        items: filtered.map((preset) => ({ kind: "preset" as const, preset })),
        loading: false,
        error: null,
        emptyMessage:
          list.length === 0 ? t("noPresets") : t("noPresetMatches", { query: trigger.query }),
      }
    }
    if (trigger.kind === "doc") {
      if (!docSearch.provider) {
        return { items: [], loading: false, error: null, emptyMessage: "" }
      }
      if (!docSearch.hostSupported) {
        // Intentional dormancy (project rule 7, UI axis): say WHY, never show
        // an empty list that reads like "you have no documents".
        return {
          items: [],
          loading: false,
          error: null,
          emptyMessage: tDocs("picker.hostUnsupported"),
        }
      }
      const accountId = docSearch.accountId
      const items: PopoverItem[] = accountId
        ? docSearch.items.map((doc) => ({
            kind: "doc" as const,
            providerId: docSearch.provider!.id,
            accountId,
            doc,
          }))
        : []
      const empty = !accountId
        ? tDocs("picker.noAccount")
        : docSearch.error
          ? tDocs(`errors.${docSearch.error.code}`, docSearch.error.params ?? {})
          : !trigger.query.trim()
            ? tDocs(docSearch.linkOnly ? "picker.linkOnlyHint" : "picker.pasteHint")
            : tDocs("picker.noMatches", { query: trigger.query })
      return {
        items,
        loading: docSearch.loading,
        error: null,
        emptyMessage: empty,
      }
    }
    if (trigger.kind === "wfNode" || trigger.kind === "wfEdge") {
      const wantType = trigger.kind === "wfNode" ? "node" : "edge"
      const list = (workflowElements ?? []).filter((el) => el.type === wantType)
      // Fuzzy over the pre-lowercased haystack (id + label + kind + endpoints).
      const filtered = fuzzyFilterSort(list, trigger.query, (el) => el.searchText)
      return {
        items: filtered.map((element) => ({ kind: "wfElement" as const, element })),
        loading: false,
        error: null,
        emptyMessage:
          list.length === 0
            ? wantType === "node"
              ? t("noWorkflowNodes")
              : t("noWorkflowEdges")
            : wantType === "node"
              ? t("noWorkflowNodeMatches", { query: trigger.query })
              : t("noWorkflowEdgeMatches", { query: trigger.query }),
      }
    }
    // file (and combined @ mode: subagents on top, then workspace files)
    const base = fileList ?? {
      items: [] as PopoverItem[],
      loading: true,
      error: null as string | null,
      emptyMessage: "",
    }
    const agentItems: PopoverItem[] =
      chatAgents && chatAgents.length > 0
        ? filterSubagents(chatAgents, trigger.query).map((target) => ({
            kind: "subagent" as const,
            target,
          }))
        : []
    if (agentItems.length === 0) return base
    return {
      items: [...agentItems, ...base.items],
      loading: base.loading,
      // Agents are showing — never surface a file-search error (e.g. no
      // workspace in web mode) that would replace the whole list. Files just
      // don't appear in that case; the agent section still works.
      error: null,
      emptyMessage: base.emptyMessage,
    }
  }, [
    trigger,
    slashQuery,
    deferredSlashQuery,
    slashCommands,
    fileList,
    t,
    tMemory,
    isDesktop,
    tAgent,
    mentionables,
    chatAgents,
    chatSkills,
    chatPresets,
    chatTemplates,
    workflowElements,
    recentCommands,
    pinnedCommands,
    docSearch,
    tDocs,
  ])

  // A changed search result set should always start from its most relevant
  // command. Deferring the query keeps large plugin/custom registries from
  // blocking keystrokes while preserving deterministic keyboard selection.
  useEffect(() => {
    if (triggerKind === "slash") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setHighlight(0)
    }
  }, [slashQuery, deferredSlashQuery, triggerKind])

  // Clamp the highlight whenever the visible list shrinks below it. The
  // updater form means the clamp is idempotent if it fires multiple times.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHighlight((h) =>
      displayList.items.length === 0 ? 0 : Math.min(Math.max(h, 0), displayList.items.length - 1)
    )
  }, [displayList.items.length])

  // Keep the highlighted row in view while navigating with the keyboard —
  // the list caps at max-h-72 and long result sets would otherwise scroll
  // the selection out of sight.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${highlight}"]`)
    // `scrollIntoView` is unimplemented in jsdom and absent on very old
    // engines — guard the method, not just the element.
    el?.scrollIntoView?.({ block: "nearest" })
  }, [highlight, displayList.items.length])

  // Surface the highlighted workflow element to the composer so it can pulse
  // the matching node on the canvas. Fires with `null` when the highlight is on
  // a non-workflow row or the popover closes (the list empties → item is
  // undefined). No-op unless a workflow composer wired `onHighlightElement`.
  useEffect(() => {
    if (!onHighlightElement) return
    const item = displayList.items[highlight]
    onHighlightElement(item && item.kind === "wfElement" ? item.element : null)
  }, [highlight, displayList.items, onHighlightElement])

  const navigate = useCallback(
    (delta: number) => {
      setHighlight((h) => {
        if (displayList.items.length === 0) return h
        return (h + delta + displayList.items.length) % displayList.items.length
      })
    },
    [displayList.items.length]
  )
  const confirm = useCallback(() => {
    const item = displayList.items[highlight]
    if (!item) return false
    onPick(item)
    return true
  }, [displayList.items, highlight, onPick])

  useImperativeHandle(ref, () => ({ navigate, confirm }), [navigate, confirm])

  const open = trigger !== null && anchor !== null
  const title = useMemo(
    () => triggerTitle(trigger?.kind, t, tAgent, tDocs),
    [trigger?.kind, t, tAgent, tDocs]
  )
  const argumentCommand =
    trigger?.kind === "slash" && trigger.argumentQuery !== undefined
      ? slashCommands.find((command) => command.name === trigger.query)
      : undefined
  const showingArgumentSuggestions =
    argumentCommand !== undefined && commandArgumentOptions(argumentCommand).length > 0
  // O(1) pin lookups per row instead of a linear scan of pinnedCommands.
  const pinnedSet = useMemo(() => new Set(pinnedCommands ?? []), [pinnedCommands])
  // Hoisted out of the per-row header check so it isn't recomputed N times.
  const hasSubagentSection = useMemo(
    () => displayList.items.some((i) => i.kind === "subagent"),
    [displayList.items]
  )

  return (
    <Popover open={open} onOpenChange={(v) => (!v ? onDismiss() : undefined)}>
      {anchor ? <PopoverAnchor virtualRef={{ current: anchor }} /> : null}
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        // The command surface is a visual extension of the composer, so both
        // share the exact anchor width at every reading-column/container size.
        className="w-[var(--radix-popper-anchor-width)] overflow-hidden rounded-xl border-border/70 bg-popover/95 p-0 shadow-xl backdrop-blur-xl duration-200 ease-out motion-reduce:animate-none motion-reduce:duration-0"
        // Don't steal focus from the textarea.
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        {trigger?.kind === "slash" ? (
          <div className="border-b bg-muted/20 p-2">
            <div className="flex h-10 items-center gap-2 rounded-lg border border-input/70 bg-background/80 px-3 shadow-xs transition-[border-color,box-shadow] duration-200 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/20 motion-reduce:transition-none">
              <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
              <input
                aria-label={
                  showingArgumentSuggestions && argumentCommand
                    ? t("searchArgumentsAria", { name: argumentCommand.name })
                    : t("searchAria")
                }
                autoComplete="off"
                className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                onBlur={() => setSlashSearch(null)}
                onChange={(event) => setSlashSearch(event.currentTarget.value)}
                onFocus={() => setSlashSearch(trigger.argumentQuery ?? trigger.query)}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing) return
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault()
                    navigate(event.key === "ArrowDown" ? 1 : -1)
                    return
                  }
                  if (event.key === "Enter" || event.key === "Tab") {
                    if (confirm()) event.preventDefault()
                    return
                  }
                  if (event.key === "Escape") {
                    // Radix owns Escape dismissal and emits one onOpenChange(false).
                    // Calling onDismiss here as well would double-fire the callback.
                    return
                  }
                }}
                placeholder={
                  showingArgumentSuggestions
                    ? t("searchArgumentsPlaceholder")
                    : t("searchPlaceholder")
                }
                spellCheck={false}
                type="search"
                value={slashQuery}
              />
              <KbdGroup aria-hidden className="hidden sm:inline-flex">
                <Kbd>↑</Kbd>
                <Kbd>↓</Kbd>
                <Kbd>↵</Kbd>
              </KbdGroup>
            </div>
            <div className="flex items-center gap-2 px-1 pt-2 text-[11px] text-muted-foreground">
              {title.icon}
              <span className="font-medium">
                {showingArgumentSuggestions && argumentCommand
                  ? t("argumentTitle", { name: argumentCommand.name })
                  : title.label}
              </span>
              <span className="ml-auto tabular-nums">
                {t(showingArgumentSuggestions ? "suggestionCount" : "resultCount", {
                  count: displayList.items.length,
                })}
              </span>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2 border-b bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
            {title.icon}
            <span className="flex-1 truncate">{title.label}</span>
            {displayList.loading ? <span>{t("searchingShort")}</span> : null}
          </div>
        )}
        {trigger?.kind === "bash" ? (
          <BashHint query={trigger.query} />
        ) : displayList.error ? (
          <div className="px-3 py-3 text-sm text-destructive">{displayList.error}</div>
        ) : displayList.items.length === 0 ? (
          <div className="flex min-h-28 flex-col items-center justify-center gap-2 px-6 py-7 text-center text-sm text-muted-foreground">
            {!displayList.loading && trigger?.kind === "slash" ? (
              <span className="rounded-full bg-muted p-2">
                <SearchXIcon className="size-4" />
              </span>
            ) : null}
            <span>{displayList.loading ? t("searching") : displayList.emptyMessage}</span>
          </div>
        ) : (
          <ul
            ref={listRef}
            className="max-h-80 scroll-py-2 overflow-y-auto overscroll-contain p-1.5"
          >
            {displayList.items.map((item, idx) => {
              // Section headers are non-selectable (no `data-index`, absent from
              // the flat item array) so keyboard nav still walks every real row.
              // Two sources: combined `@` mode (subagents/files by kind change),
              // and the empty-query slash view (Pinned/Recent/category groups).
              const prev = idx === 0 ? undefined : displayList.items[idx - 1]
              const header = sectionHeader(item, prev, hasSubagentSection, t)
              return (
                <Fragment key={itemKey(item, idx)}>
                  {header ? (
                    <li
                      aria-hidden
                      className="sticky top-0 mt-2 bg-popover/95 px-2.5 py-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground backdrop-blur-sm"
                    >
                      {header}
                    </li>
                  ) : null}
                  <li
                    data-index={idx}
                    data-active={idx === highlight ? "true" : undefined}
                    className={cn(
                      "group/row flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-sm transition-colors duration-150 motion-reduce:transition-none",
                      idx === highlight ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"
                    )}
                    onMouseEnter={() => setHighlight(idx)}
                    onMouseDown={(e) => {
                      // Prevent the textarea blur that would otherwise fire.
                      e.preventDefault()
                      onPick(item)
                    }}
                  >
                    <ItemRow
                      item={item}
                      pinned={item.kind === "slash" ? pinnedSet.has(item.command.name) : false}
                      onTogglePin={onTogglePin}
                    />
                  </li>
                </Fragment>
              )
            })}
          </ul>
        )}
        {trigger?.kind === "doc" && docSearch.hostSupported && docSearch.accounts?.length ? (
          <div className="flex items-center gap-2 border-t bg-muted/15 px-3 py-2 text-[11px] leading-4 text-muted-foreground">
            <span className="shrink-0">{tDocs("picker.accountLabel")}</span>
            {docSearch.accounts.length === 1 ? (
              <span className="truncate" data-testid="composer-doc-account">
                {docSearch.accounts[0].label}
              </span>
            ) : (
              <Select
                value={docSearch.accountId ?? undefined}
                onValueChange={docSearch.setAccountId}
              >
                <SelectTrigger
                  size="sm"
                  className="h-6 border-none bg-transparent px-1 text-[11px] shadow-none"
                  data-testid="composer-doc-account"
                  // The composer keeps the textarea focused; a mousedown here
                  // must not blur it and dismiss the popover before the click.
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {docSearch.accounts.map((account) => (
                    <SelectItem key={account.id} value={account.id}>
                      {account.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        ) : null}
        {trigger?.kind === "slash" || trigger?.kind === "skill" ? (
          <div className="flex items-center gap-2 border-t bg-muted/15 px-3 py-2 text-[11px] leading-4 text-muted-foreground">
            {trigger.kind === "slash" ? (
              <ListPlusIcon className="size-3.5 shrink-0" />
            ) : (
              <SparklesIcon className="size-3.5 shrink-0" />
            )}
            <span>{t(trigger.kind === "slash" ? "multiCommandHint" : "multiSkillHint")}</span>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  )
})

function triggerTitle(
  kind: TriggerKind | undefined,
  t: (key: string) => string,
  tAgent: (key: string) => string,
  tDocs: (key: string) => string
): {
  icon: React.ReactNode
  label: string
} {
  switch (kind) {
    case "slash":
      return { icon: <SquareTerminalIcon className="size-3.5" />, label: t("slashTitle") }
    case "file":
      return { icon: <FileIcon className="size-3.5" />, label: t("fileTitle") }
    case "memory":
      return {
        icon: <BookMarkedIcon className="size-3.5" />,
        label: t("memoryTitle"),
      }
    case "bash":
      return { icon: <TerminalIcon className="size-3.5" />, label: t("bashTitle") }
    case "skill":
      return { icon: <SparklesIcon className="size-3.5" />, label: t("skillTitle") }
    case "preset":
      return { icon: <WandSparklesIcon className="size-3.5" />, label: t("presetTitle") }
    case "wfNode":
      return { icon: <BoxIcon className="size-3.5" />, label: t("wfNodeTitle") }
    case "wfEdge":
      return { icon: <SplineIcon className="size-3.5" />, label: t("wfEdgeTitle") }
    case "doc":
      return { icon: <CloudIcon className="size-3.5" />, label: tDocs("picker.title") }
    case "agent":
      return {
        icon: <AtSignIcon className="size-3.5" />,
        label: safeLookup(tAgent, "mentionTitle", "Mention an agent"),
      }
    default:
      return { icon: null, label: "" }
  }
}

/**
 * Section-header label for a row, or null when no header precedes it. Covers the
 * empty-query slash grouping (Pinned/Recent/category) and the combined-`@` mode
 * (subagents/files). Headers carry no `data-index`, so keyboard nav is unaffected.
 */
function sectionHeader(
  item: PopoverItem,
  prev: PopoverItem | undefined,
  hasSubagentSection: boolean,
  t: (key: string, params?: Record<string, string | number | Date>) => string
): string | null {
  if (item.kind === "slash" && item.group) {
    const prevGroup = prev && prev.kind === "slash" ? prev.group : undefined
    return item.group !== prevGroup ? slashGroupLabel(item.group, t, safeLookup) : null
  }
  if (item.kind === "chatTemplate" && prev?.kind !== "chatTemplate") {
    return t("templatesSection")
  }
  if (
    hasSubagentSection &&
    item.kind !== prev?.kind &&
    (item.kind === "subagent" || item.kind === "file")
  ) {
    return item.kind === "subagent" ? t("agentsSection") : t("filesSection")
  }
  return null
}

function safeLookup(
  t: (key: string, params?: Record<string, string | number | Date>) => string,
  key: string,
  fallback: string,
  params?: Record<string, string | number | Date>
): string {
  try {
    const value = t(key, params)
    if (value && value !== key) return value
  } catch {
    /* fall through */
  }
  return fallback
}

function commandArgumentOptions(command: SlashCommand | undefined): readonly string[] {
  if (!command) return []
  if (command.argumentOptions && command.argumentOptions.length > 0) {
    return command.argumentOptions
  }
  return command.params?.find((param) => param.type === "enum")?.options ?? []
}

function argumentHintParts(hint: string | undefined): string[] {
  if (!hint) return []
  const trimmed = hint.trim()
  const hasWrapper =
    (trimmed.startsWith("<") && trimmed.endsWith(">")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  const unwrapped = hasWrapper ? trimmed.slice(1, -1) : trimmed
  return unwrapped
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean)
}

function commandIconKey(command: SlashCommand): string {
  if (command.name === "loop") return "loop"
  if (command.scope === "plugin" || command.category === "plugins") return "plugins"
  if (command.scope === "project" || command.scope === "user") return "custom"
  return command.category ?? "other"
}

function CommandCategoryIcon({ command }: { command: SlashCommand }) {
  const className = "size-4"
  switch (commandIconKey(command)) {
    case "chat":
      return <MessageCircleMoreIcon className={className} />
    case "diagnostics":
      return <ActivityIcon className={className} />
    case "system":
      return <Settings2Icon className={className} />
    case "goal":
      return <TargetIcon className={className} />
    case "help":
      return <CircleHelpIcon className={className} />
    case "plugins":
      return <BlocksIcon className={className} />
    case "template":
      return <WandSparklesIcon className={className} />
    case "loop":
      return <Repeat2Icon className={className} />
    case "custom":
      return <FileCode2Icon className={className} />
    default:
      return <SquareTerminalIcon className={className} />
  }
}

function itemKey(item: PopoverItem, idx: number): string {
  if (item.kind === "slash") return `slash-${item.command.name}`
  if (item.kind === "slashArgument") {
    return `slash-argument-${item.command.name}-${item.value}`
  }
  if (item.kind === "file") return `file-${item.entry.absolutePath}`
  if (item.kind === "memory") return `memory-${memoryTargetKey(item.target)}`
  if (item.kind === "agent") return `agent-${item.target.id}`
  if (item.kind === "subagent") return `subagent-${item.target.id}`
  if (item.kind === "skill") return `skill-${item.skill.id}`
  if (item.kind === "preset") return `preset-${item.preset.id}`
  if (item.kind === "chatTemplate") return `chat-template-${item.template.id}`
  if (item.kind === "wfElement") return `wf-${item.element.type}-${item.element.id}`
  if (item.kind === "doc") return `doc-${item.providerId}-${item.doc.kind}-${item.doc.id}`
  return `idx-${idx}`
}

// Memoised so navigating the highlight (a parent-level class change) only
// re-renders the two affected rows, not the entire candidate list.
const ItemRow = memo(function ItemRow({
  item,
  pinned,
  onTogglePin,
}: {
  item: PopoverItem
  pinned: boolean
  onTogglePin?: (name: string) => void
}) {
  const t = useTranslations("chat.composer.popover")
  const tMemory = useTranslations("chat.composer.memory")
  const tDocs = useTranslations("docsProviders")
  if (item.kind === "slash") {
    const c = item.command
    const hintParts = argumentHintParts(c.argumentHint)
    return (
      <>
        <span
          className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted/70 text-muted-foreground transition-colors group-data-[active=true]/row:bg-background/70 group-data-[active=true]/row:text-foreground motion-reduce:transition-none"
          data-command-icon={commandIconKey(c)}
        >
          <CommandCategoryIcon command={c} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-2">
            <span
              className={cn("shrink-0 font-mono text-xs font-medium", c.disabled && "opacity-60")}
            >
              /<MatchHighlight text={c.name} positions={item.positions ?? []} />
            </span>
            {hintParts.length > 0 ? (
              <>
                {" "}
                <span
                  className="flex min-w-0 items-center gap-1 overflow-hidden"
                  title={c.argumentHint}
                >
                  {hintParts.slice(0, 4).map((part) => (
                    <span
                      key={part}
                      className="shrink-0 rounded-md border border-border/70 bg-muted/50 px-1.5 py-0.5 font-mono text-[10px] leading-none text-muted-foreground"
                      data-slot="command-argument"
                    >
                      {part}
                    </span>
                  ))}
                  {hintParts.length > 4 ? (
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      +{hintParts.length - 4}
                    </span>
                  ) : null}
                </span>
              </>
            ) : null}
          </span>
          <span
            className={cn(
              "block truncate text-xs leading-5 text-muted-foreground",
              c.disabled && "italic"
            )}
          >
            {c.disabled ? t("comingSoon") : c.description}
          </span>
        </span>
        {onTogglePin ? (
          <button
            type="button"
            aria-label={
              pinned ? t("unpinAction", { name: c.name }) : t("pinAction", { name: c.name })
            }
            className={cn(
              "shrink-0 rounded p-0.5 text-muted-foreground transition-opacity hover:text-foreground",
              pinned
                ? "opacity-100"
                : // Reveal on row hover / keyboard-highlight at pointer-fine; always
                  // visible on touch (no hover, no keyboard) so pinning is reachable.
                  "opacity-0 group-hover/row:opacity-100 group-data-[active=true]/row:opacity-100 [@media(hover:none)]:opacity-100"
            )}
            onMouseDown={(e) => {
              // A pin click must not pick/insert the command underneath it.
              e.preventDefault()
              e.stopPropagation()
              onTogglePin(c.name)
            }}
          >
            {pinned ? <PinOffIcon className="size-3.5" /> : <PinIcon className="size-3.5" />}
          </button>
        ) : null}
        <Badge variant="outline" className="shrink-0 px-1.5 text-[10px] font-normal">
          {c.scope}
        </Badge>
      </>
    )
  }
  if (item.kind === "slashArgument") {
    return (
      <>
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted/70 text-muted-foreground">
          <CornerDownRightIcon className="size-4" />
        </span>
        <span className="font-mono text-sm font-medium">{item.value}</span>
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
  if (item.kind === "doc") {
    const { doc } = item
    const Icon = doc.kind === "sheet" ? SheetIcon : doc.kind === "bitable" ? TableIcon : CloudIcon
    return (
      <>
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate font-medium">{doc.title}</span>
        <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
          {tDocs(`kind.${doc.kind}`)}
        </span>
      </>
    )
  }
  if (item.kind === "memory") {
    const isStore = item.target.target === "store"
    return (
      <>
        {isStore ? (
          <BrainIcon className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <BookMarkedIcon className="size-4 shrink-0 text-muted-foreground" />
        )}
        <span className={cn("font-medium", !item.available && "text-muted-foreground")}>
          {tMemory(`targetLabel.${memoryTargetKey(item.target)}`)}
        </span>
        <span className="ml-auto truncate text-xs text-muted-foreground">
          {item.available ? item.preview : tMemory("desktopOnly")}
        </span>
      </>
    )
  }
  if (item.kind === "agent") {
    return <AgentMentionRow target={item.target} />
  }
  if (item.kind === "subagent") {
    return <SubagentMentionRow target={item.target} />
  }
  if (item.kind === "chatTemplate") {
    const template = item.template
    return (
      <>
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted/70 text-muted-foreground transition-colors group-data-[active=true]/row:bg-background/70 group-data-[active=true]/row:text-foreground motion-reduce:transition-none">
          <FileCode2Icon className="size-4" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm">{template.name}</span>
          {template.description ? (
            <span className="truncate text-xs text-muted-foreground">{template.description}</span>
          ) : null}
        </span>
        {template.params.length > 0 ? (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {t("templateParamCount", { count: template.params.length })}
          </span>
        ) : null}
      </>
    )
  }
  if (item.kind === "skill") {
    return (
      <>
        <SparklesIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate font-medium">{item.skill.name}</span>
        {item.skill.description ? (
          <span className="ml-auto truncate text-xs text-muted-foreground">
            {item.skill.description}
          </span>
        ) : null}
      </>
    )
  }
  if (item.kind === "preset") {
    const p = item.preset
    return (
      <>
        <span aria-hidden className="shrink-0 text-sm">
          {p.icon ? p.icon : <WandSparklesIcon className="size-4 text-muted-foreground" />}
        </span>
        <span className="truncate font-medium">{p.name}</span>
        {p.description ? (
          <span className="ml-auto truncate text-xs text-muted-foreground">{p.description}</span>
        ) : null}
      </>
    )
  }
  if (item.kind === "wfElement") {
    const el = item.element
    const Icon = el.type === "node" ? BoxIcon : SplineIcon
    return (
      <>
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate font-medium">{el.label}</span>
        <span className="ml-auto shrink-0 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
          {el.kind}
        </span>
      </>
    )
  }
  return null
})

function BashHint({ query }: { query: string }) {
  const t = useTranslations("chat.composer.popover")
  return (
    <div className="px-3 py-3 text-sm text-muted-foreground">
      <p className="mb-1">
        {/* i18n-exempt: keyboard key cap, locale-invariant */}
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
