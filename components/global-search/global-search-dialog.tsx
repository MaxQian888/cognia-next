"use client"

/**
 * The unified global search / command palette (ADR-0129).
 *
 * One dialog for desktop and mobile. It owns its open state (unless a host
 * controls it), listens on the `command-palette-request` seam, registers the
 * rebindable `app.commandPalette.toggle` shortcut, and renders the engine's
 * groups with cmdk's own filtering turned off — ranking is the engine's job.
 *
 * Keyboard: ↑↓ move, ↵ open, Tab / Shift+Tab cycle scopes, Alt+1…7 jump to a
 * scope, Backspace on an empty field drops the last filter chip, Esc closes.
 */

import { SearchIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { useCallback, useEffect, useMemo, useState } from "react"
import { Command as CommandPrimitive } from "cmdk"
import { loggers } from "@cognia/logging"

import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"
import { CommandGroup, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import { useSessions } from "@/hooks/chat"
import { useGlobalSearch } from "@/hooks/global-search/use-global-search"
import {
  useGlobalSearchActions,
  type GlobalSearchHost,
} from "@/hooks/global-search/use-global-search-actions"
import { useGlobalSearchContext } from "@/hooks/global-search/use-global-search-context"
import { useAppShortcut } from "@/hooks/shortcuts/use-app-shortcut"
import { usePlatform } from "@/hooks/use-platform"
import { invalidateGlobalSearchCaches } from "@/lib/global-search/cache"
import { SCOPED_GROUP_LIMIT } from "@/lib/global-search/engine"
import { removeFilterToken, setFilterToken } from "@/lib/global-search/query-parser"
import { recordRecentQuery, type RecentItem } from "@/lib/global-search/recents"
import { trackEvent } from "@/lib/telemetry/events/track-event"
import {
  primaryScopeOf,
  type GlobalSearchGroup,
  type GlobalSearchItem,
  type GlobalSearchScope,
} from "@/lib/global-search/types"
import { onCommandPaletteRequest } from "@/lib/shell/command-palette-request"
import { cn } from "@/lib/utils"

import { GlobalSearchEmptyState } from "./global-search-empty-state"
import { GlobalSearchFilterChips } from "./global-search-filter-chips"
import { GlobalSearchFooter } from "./global-search-footer"
import { GlobalSearchResultRow } from "./global-search-result-row"
import { cycleScope, GlobalSearchScopeTabs, scopeForDigit } from "./global-search-scope-tabs"

const log = loggers.ui

export interface GlobalSearchDialogProps {
  /** Shell-specific effects (settings routing, mobile picker / drawer). */
  host: GlobalSearchHost
  /** Controlled open state — omit to let the dialog own it. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

export function GlobalSearchDialog({
  host,
  open: controlledOpen,
  onOpenChange,
}: GlobalSearchDialogProps) {
  const t = useTranslations("globalSearch")
  const platform = usePlatform()
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const open = controlledOpen ?? uncontrolledOpen
  const [rawQuery, setRawQuery] = useState("")
  const [scope, setScope] = useState<GlobalSearchScope>("all")
  const [limit, setLimit] = useState<number | undefined>(undefined)

  const { sessions, select, create } = useSessions({ crossWorkspace: true })
  const ctx = useGlobalSearchContext({ sessions, scope })
  // Named, not just "this workspace": the point of the chip is to say WHICH
  // one, since the reason a hit is missing is that it lives in another.
  const activeWorkspaceName = ctx.workspaces.find(
    (workspace) => workspace.id === ctx.activeProjectId
  )?.name
  const { parsed, outcome, suggestions, loading, error } = useGlobalSearch({
    rawQuery,
    ctx,
    enabled: open,
    limit,
  })

  const setOpen = useCallback(
    (next: boolean) => {
      if (controlledOpen === undefined) setUncontrolledOpen(next)
      onOpenChange?.(next)
    },
    [controlledOpen, onOpenChange]
  )

  const reset = useCallback(() => {
    setRawQuery("")
    setScope("all")
    setLimit(undefined)
  }, [])

  const close = useCallback(() => {
    setOpen(false)
    reset()
  }, [setOpen, reset])

  const openWith = useCallback(
    (detail: { query?: string; scope?: GlobalSearchScope }, source: string) => {
      log.info("global-search open", { source, seeded: Boolean(detail.query), scope: detail.scope })
      void trackEvent("app.search.opened", {
        via: source,
        scope: detail.scope ?? "all",
        // The flag only records *that* the opener seeded a query; its text
        // never leaves the renderer.
        seeded: Boolean(detail.query),
      })
      invalidateGlobalSearchCaches()
      setLimit(undefined)
      if (detail.scope) setScope(detail.scope)
      if (detail.query !== undefined) setRawQuery(detail.query)
      setOpen(true)
    },
    [setOpen]
  )

  // Programmatic requests: title-bar pill, native menu, rail "search everywhere",
  // settings shell — one seam for all of them.
  useEffect(() => onCommandPaletteRequest((detail) => openWith(detail, "request")), [openWith])

  // The rebindable ⌘/Ctrl+K. Fires while typing in the composer too.
  useAppShortcut(
    "app.commandPalette.toggle",
    () => {
      if (open) close()
      else openWith({}, "shortcut")
    },
    { allowInEditable: true, preventDefault: true }
  )

  // Fresh caches for a controlled open (mobile drives `open` from its bar).
  useEffect(() => {
    if (controlledOpen) invalidateGlobalSearchCaches()
  }, [controlledOpen])

  const { runItem, runStoredAction } = useGlobalSearchActions({
    host,
    sessions,
    select,
    create,
    close,
  })

  const handleSelect = useCallback(
    (item: GlobalSearchItem) => {
      if (parsed.text) recordRecentQuery(parsed.raw)
      runItem(item)
    },
    [parsed, runItem]
  )

  const handleRecent = useCallback(
    (item: RecentItem) => {
      log.info("global-search recent", { id: item.id })
      runStoredAction(item.action as unknown as { type: string } & Record<string, unknown>)
    },
    [runStoredAction]
  )

  const changeScope = useCallback((next: GlobalSearchScope) => {
    setScope(next)
    setLimit(undefined)
  }, [])

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Tab") {
        event.preventDefault()
        changeScope(cycleScope(scope, event.shiftKey ? -1 : 1))
        return
      }
      if (event.altKey && /^[1-9]$/.test(event.key)) {
        const next = scopeForDigit(Number(event.key))
        if (next) {
          event.preventDefault()
          changeScope(next)
        }
        return
      }
      if (event.key === "Backspace" && parsed.text === "" && parsed.tokens.length > 0) {
        // No free text left, only filter chips, caret at the end: Backspace
        // drops the last chip whole instead of eating it letter by letter.
        const target = event.target as HTMLInputElement
        const caret =
          typeof target.selectionStart === "number" ? target.selectionStart : rawQuery.length
        if (caret < rawQuery.length) return
        event.preventDefault()
        setRawQuery(removeFilterToken(rawQuery, parsed.tokens[parsed.tokens.length - 1]!))
      }
    },
    [changeScope, scope, rawQuery, parsed.text, parsed.tokens]
  )

  const groups = outcome?.groups ?? []
  const isEmptyQuery = parsed.text.length === 0 && parsed.tokens.length === 0
  const showEmpty = !isEmptyQuery && !loading && !error && groups.length === 0
  const placeholder = scope === "all" ? t("placeholder") : t(`placeholders.${scope}`)

  // Per-scope hit counts for the tab suffixes (only meaningful in *All*).
  const counts = useMemo(() => {
    if (!outcome || scope !== "all") return undefined
    const acc: Partial<Record<GlobalSearchScope, number>> = { all: outcome.totalHits }
    for (const group of outcome.groups) {
      const key = primaryScopeOf(group.kind)
      acc[key] = (acc[key] ?? 0) + group.total
      // Messages count toward the deep tab as well.
      if (group.kind === "message") acc.messages = (acc.messages ?? 0) + group.total
    }
    return acc
  }, [outcome, scope])

  const groupHeading = (group: GlobalSearchGroup) =>
    group.kind === "message" && scope === "chats"
      ? t("groups.messagesInChats", { query: parsed.text })
      : t(`kinds.${group.kind}`)

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
      <DialogContent
        showCloseButton={false}
        className={cn(
          "overflow-hidden p-0",
          platform === "mobile"
            ? "top-0 left-0 h-[100dvh] max-w-none translate-x-0 translate-y-0 rounded-none border-0"
            : "sm:max-w-2xl"
        )}
        data-testid="global-search-dialog"
      >
        {/* Inside the content so the accessible name only exists while open. */}
        <DialogHeader className="sr-only">
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <CommandPrimitive
          shouldFilter={false}
          loop
          label={t("title")}
          onKeyDown={handleKeyDown}
          data-slot="command"
          className="flex h-full w-full flex-col overflow-hidden rounded-md bg-popover text-popover-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group]]:px-2 [&_[cmdk-item]]:px-2 [&_[cmdk-item]_svg]:h-4 [&_[cmdk-item]_svg]:w-4"
        >
          <GlobalSearchScopeTabs value={scope} onChange={changeScope} counts={counts} />
          <div
            data-slot="command-input-wrapper"
            className="flex h-11 items-center gap-2 border-b px-3"
          >
            <SearchIcon className="size-4 shrink-0 opacity-50" aria-hidden />
            <CommandPrimitive.Input
              value={rawQuery}
              onValueChange={setRawQuery}
              placeholder={placeholder}
              autoFocus
              data-slot="command-input"
              data-testid="global-search-input"
              className="flex h-10 w-full rounded-md bg-transparent py-3 text-sm outline-hidden placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
            />
            {loading ? <Spinner className="size-4 shrink-0" aria-hidden /> : null}
          </div>
          <GlobalSearchFilterChips
            tokens={parsed.tokens}
            onRemove={(token) => setRawQuery(removeFilterToken(rawQuery, token))}
            // Only for the IMPLICIT case: with an explicit `workspace:` token
            // the ordinary removable chip already says it, and two chips for
            // one filter is how a surface starts contradicting itself.
            workspaceScope={
              parsed.filters.workspace === "current" &&
              !parsed.tokens.some((token) => token.key === "workspace") &&
              activeWorkspaceName
                ? {
                    name: activeWorkspaceName,
                    onWiden: () => setRawQuery(setFilterToken(rawQuery, "workspace", "all")),
                  }
                : null
            }
            className="pt-2"
          />
          <CommandList
            label={t("suggestions")}
            className={cn("max-h-[min(60vh,560px)]", platform === "mobile" && "max-h-none flex-1")}
          >
            {isEmptyQuery ? (
              <GlobalSearchEmptyState
                suggestions={suggestions}
                onPickQuery={(query) => setRawQuery(query)}
                onPickRecent={handleRecent}
                onSelect={handleSelect}
              />
            ) : null}

            {error ? (
              <div className="px-3 py-6 text-center text-sm text-muted-foreground" role="alert">
                {t("error", { message: error.message })}
              </div>
            ) : null}

            {showEmpty ? (
              <div className="px-3 py-8 text-center text-sm" data-testid="global-search-empty">
                {parsed.text ? (
                  <>
                    <p>{t("empty", { query: parsed.text })}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{t("emptyHint")}</p>
                  </>
                ) : (
                  // Filters only, no words yet.
                  <p className="text-xs text-muted-foreground">{t("emptyFilters")}</p>
                )}
              </div>
            ) : null}

            {!isEmptyQuery
              ? groups.map((group, index) => (
                  <div key={group.providerId} data-testid={`global-search-group-${group.kind}`}>
                    {index > 0 ? <CommandSeparator /> : null}
                    <CommandGroup heading={groupHeading(group)}>
                      {group.error ? (
                        <CommandItem disabled value={`error:${group.providerId}`}>
                          <span className="text-xs text-muted-foreground">
                            {t("error", { message: group.error })}
                          </span>
                        </CommandItem>
                      ) : null}
                      {group.items.map((item) => (
                        <GlobalSearchResultRow key={item.id} item={item} onSelect={handleSelect} />
                      ))}
                      {group.truncated && scope === "all" ? (
                        <CommandItem
                          value={`show-all:${group.providerId}`}
                          onSelect={() => changeScope(primaryScopeOf(group.kind))}
                          className="justify-center text-xs text-muted-foreground"
                          data-testid={`global-search-show-all-${group.kind}`}
                        >
                          {t("showAll", {
                            count: group.total,
                            scope: t(`scopes.${primaryScopeOf(group.kind)}`),
                          })}
                        </CommandItem>
                      ) : null}
                      {group.truncated && scope !== "all" ? (
                        <CommandItem
                          value={`show-more:${group.providerId}`}
                          onSelect={() =>
                            setLimit(
                              (current) => (current ?? SCOPED_GROUP_LIMIT) + SCOPED_GROUP_LIMIT
                            )
                          }
                          className="justify-center text-xs text-muted-foreground"
                          data-testid={`global-search-show-more-${group.kind}`}
                        >
                          {t("showMore")}
                        </CommandItem>
                      ) : null}
                    </CommandGroup>
                  </div>
                ))
              : null}

            <PluginExtensionSlot point="command-palette" className="border-t pt-1 empty:hidden" />
          </CommandList>
          <GlobalSearchFooter
            totalHits={outcome && !isEmptyQuery ? outcome.totalHits : null}
            tookMs={outcome && !isEmptyQuery ? outcome.tookMs : null}
            coverage={outcome && !isEmptyQuery ? outcome.coverage : "complete"}
            loading={loading}
          />
        </CommandPrimitive>
      </DialogContent>
    </Dialog>
  )
}
