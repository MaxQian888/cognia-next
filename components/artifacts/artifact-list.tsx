"use client"

/**
 * ArtifactList - Displays the artifact list for the current session.
 * Adapted from Cognia: inlines a small empty-state component (cognia-next
 * has no shared `EmptyState` primitive yet).
 */

import { useTranslations } from "next-intl"
import { formatDistanceToNow } from "date-fns"
import { Trash2, Code, Search, Filter, CheckSquare, Eye, Loader2, Clock } from "lucide-react"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { cn } from "@/lib/utils"
import { getPluginEventHooks } from "@/lib/plugin/messaging/hooks-system"
import type { Artifact } from "@/types"
import { ARTIFACT_TYPES, ARTIFACT_TYPE_KEYS, PREVIEWABLE_TYPES } from "@/lib/artifacts"
import { useArtifactList } from "@/hooks/artifacts/use-artifact-list"
import { useStreamingArtifact } from "@/hooks/artifacts/use-streaming-artifact"
import type { StreamingArtifact } from "@/lib/ai/generation/artifact-detector"
import { getArtifactTypeIcon } from "./artifact-icons"

/**
 * The artifact the assistant is still writing, rendered in the slot the real
 * one will occupy. Without it a finished artifact simply appears from nowhere,
 * because nothing exists in the store until the turn seals.
 */
function GeneratingArtifactRow({ pending }: { pending: StreamingArtifact }) {
  const t = useTranslations("artifacts")
  return (
    <div
      data-testid="artifact-list-generating"
      aria-live="polite"
      className="flex w-full items-center gap-2 rounded-md border border-dashed px-3 py-2"
    >
      <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
      <div className="min-w-0 flex-1 text-left">
        <p className="truncate text-sm font-medium">{pending.title}</p>
        <p className="text-xs text-muted-foreground">{t("generating")}</p>
      </div>
      <Badge variant="outline" className="shrink-0 text-xs">
        {t(`types.${TYPE_LABEL_KEYS[pending.type]}`)}
      </Badge>
    </div>
  )
}

interface ArtifactListProps {
  sessionId?: string
  className?: string
  maxHeight?: string
  onArtifactClick?: (artifact: Artifact) => void
}

const TYPE_LABEL_KEYS = ARTIFACT_TYPE_KEYS

/**
 * Filter triggers shrink to a square icon button in a narrow container. `w-8`
 * plus `shrink-0` is what keeps the row inside the dock; the chevron is hidden
 * because there is no room for it beside the icon.
 */
const COMPACT_FILTER_TRIGGER =
  "relative h-8 w-8 shrink-0 justify-center px-0 text-xs [&>svg:last-child]:hidden @[380px]/artifact-list:w-auto @[380px]/artifact-list:justify-between @[380px]/artifact-list:px-3 @[380px]/artifact-list:[&>svg:last-child]:block"

/** Marks a filter as narrowed while its label is hidden by the compact layout. */
function FilterActiveDot() {
  return (
    <span
      aria-hidden
      className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-primary @[380px]/artifact-list:hidden"
    />
  )
}

function ListEmptyState({
  title,
  description,
  className,
}: {
  title: string
  description: string
  className?: string
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 px-6 py-10 text-center",
        className
      )}
    >
      <Code className="h-8 w-8 text-muted-foreground/60" />
      <div className="space-y-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
    </div>
  )
}

export function ArtifactList({
  sessionId,
  className,
  maxHeight = "400px",
  onArtifactClick,
}: ArtifactListProps) {
  const t = useTranslations("artifactList")
  const tArtifacts = useTranslations("artifacts")

  const {
    activeArtifactId,
    searchQuery,
    typeFilter,
    runtimeFilter,
    selectedIds,
    batchMode,
    pendingDelete,
    sessionArtifacts,
    setSearchQuery,
    setTypeFilter,
    setRuntimeFilter,
    setPendingDelete,
    toggleBatchMode,
    handleArtifactClick,
    handleDelete,
    handleBatchDelete,
    confirmDelete,
    scope,
    setScope,
    hasAnyArtifacts,
  } = useArtifactList({ sessionId, onArtifactClick })
  const pending = useStreamingArtifact(sessionId)

  // The full-height empty state replaces the filter row, so it is only correct
  // when there is genuinely nothing to filter. Showing it whenever *this*
  // session was empty hid the controls a user needs to widen the scope or clear
  // the filter that emptied the list — including the scope switcher that would
  // have shown them their other chats' artifacts.
  if (!hasAnyArtifacts) {
    // "No artifacts yet" would be a lie while one is being written.
    if (pending) {
      return (
        <div data-testid="artifact-list" className={cn("p-2", className)} style={{ maxHeight }}>
          <GeneratingArtifactRow pending={pending} />
        </div>
      )
    }
    return (
      <ListEmptyState
        title={t("noArtifacts")}
        description={t("noArtifactsDesc")}
        className={className}
      />
    )
  }

  return (
    <div
      data-testid="artifact-list"
      className={cn("@container/artifact-list flex flex-col", className)}
      style={{ maxHeight }}
    >
      {/* Search and Filter Bar. The two filters carry fixed widths and, as flex
          items, default to `min-width: auto` — so at the dock's narrowest
          (~200px of content once the activity rail is subtracted) this row
          overflowed and `overflow-hidden` silently clipped the batch button off
          the end. They collapse to icon-only triggers below 380px instead.
          Container query, not a viewport breakpoint: the dock's width is
          user-dragged and has nothing to do with the window's. */}
      <div
        className="flex shrink-0 items-center gap-2 p-2 border-b"
        role="search"
        aria-label={tArtifacts("search")}
      >
        <div className="relative min-w-0 flex-1">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder={tArtifacts("search")}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-8 pl-7 text-xs"
            aria-label={tArtifacts("search")}
          />
        </div>
        {/* Scope. The store has always maintained a cross-session MRU list and
            had a `recent` branch to read it with, but no control ever selected
            that branch — the capability was complete and unreachable. */}
        <Select value={scope} onValueChange={setScope}>
          <SelectTrigger
            data-testid="scope-filter-select"
            aria-label={tArtifacts("scopeLabel")}
            className={cn(COMPACT_FILTER_TRIGGER, "@[380px]/artifact-list:w-[110px]")}
          >
            <Clock className="h-3 w-3 @[380px]/artifact-list:mr-1" />
            <span className="hidden @[380px]/artifact-list:contents">
              <SelectValue />
            </span>
            {scope !== "session" && <FilterActiveDot />}
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="session">{tArtifacts("scopes.session")}</SelectItem>
            <SelectItem value="recent">{tArtifacts("scopes.recent")}</SelectItem>
          </SelectContent>
        </Select>
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger
            data-testid="type-filter-select"
            aria-label={tArtifacts("allTypes")}
            className={cn(COMPACT_FILTER_TRIGGER, "@[380px]/artifact-list:w-[120px]")}
          >
            <Filter className="h-3 w-3 @[380px]/artifact-list:mr-1" />
            <span className="hidden @[380px]/artifact-list:contents">
              <SelectValue />
            </span>
            {typeFilter !== "all" && <FilterActiveDot />}
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{tArtifacts("allTypes")}</SelectItem>
            {ARTIFACT_TYPES.map((type) => (
              <SelectItem key={type} value={type}>
                {t(`types.${TYPE_LABEL_KEYS[type]}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={runtimeFilter} onValueChange={setRuntimeFilter}>
          <SelectTrigger
            data-testid="runtime-filter-select"
            aria-label={tArtifacts("allRuntimeStates")}
            className={cn(COMPACT_FILTER_TRIGGER, "@[380px]/artifact-list:w-[140px]")}
          >
            <Eye className="h-3 w-3 @[380px]/artifact-list:mr-1" />
            <span className="hidden @[380px]/artifact-list:contents">
              <SelectValue />
            </span>
            {runtimeFilter !== "all" && <FilterActiveDot />}
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{tArtifacts("allRuntimeStates")}</SelectItem>
            <SelectItem value="ready">{tArtifacts("runtimeStates.ready")}</SelectItem>
            {/* No `loading` option. It is deliberately never persisted — it
                describes the preview currently on screen, not the artifact —
                so filtering by it could only ever return an empty list. The
                `runtimeStates.loading` message stays in the bundle for the
                in-preview badge, which does show the live state. */}
            <SelectItem value="error">{tArtifacts("runtimeStates.error")}</SelectItem>
            <SelectItem value="unsupported">{tArtifacts("runtimeStates.unsupported")}</SelectItem>
          </SelectContent>
        </Select>
        <Button
          variant={batchMode ? "secondary" : "ghost"}
          size="icon"
          className="h-8 w-8 shrink-0"
          onClick={toggleBatchMode}
        >
          <CheckSquare className="h-3.5 w-3.5" />
          <span className="sr-only">{tArtifacts("batchSelect")}</span>
        </Button>
      </div>

      {/* Batch Actions */}
      {batchMode && selectedIds.size > 0 && (
        <div
          className="flex shrink-0 items-center justify-between px-3 py-1.5 bg-destructive/10 border-b"
          role="alert"
        >
          <span className="text-xs text-destructive">
            {tArtifacts("batchDeleteConfirm", { count: selectedIds.size })}
          </span>
          <Button
            variant="destructive"
            size="sm"
            className="h-6 text-xs"
            onClick={handleBatchDelete}
          >
            <Trash2 className="h-3 w-3 mr-1" />
            {tArtifacts("batchDelete")}
          </Button>
        </div>
      )}

      {/* Was `calc(${maxHeight} - 48px)`: a hardcoded guess at the filter bar's
          height that ignored its 1px border and knew nothing about the batch
          bar, so the last row was clipped — worse once batch mode was on. The
          flex column derives the remainder instead. */}
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-1 p-2">
          {pending ? <GeneratingArtifactRow pending={pending} /> : null}
          {sessionArtifacts.length === 0 && (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">{t("noMatches")}</p>
          )}
          {sessionArtifacts.map((artifact) => {
            const createdAt =
              artifact.createdAt instanceof Date ? artifact.createdAt : new Date(artifact.createdAt)

            return (
              <ContextMenu
                key={artifact.id}
                onOpenChange={(open) => {
                  if (open) {
                    // Plugin host: announce the artifact-list context-menu open
                    // so plugins can observe / react (Phase 1 dispatch only).
                    void getPluginEventHooks().dispatchContextMenuShow({
                      type: "artifact-list",
                      target: { artifactId: artifact.id, artifactType: artifact.type },
                    })
                  }
                }}
              >
                <ContextMenuTrigger>
                  <Button
                    data-testid={`artifact-list-item-${artifact.id}`}
                    variant={activeArtifactId === artifact.id ? "secondary" : "ghost"}
                    className={cn(
                      "w-full justify-start gap-2 h-auto py-2 px-3",
                      activeArtifactId === artifact.id && "bg-secondary"
                    )}
                    onClick={() => handleArtifactClick(artifact)}
                  >
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      <span className="text-muted-foreground shrink-0">
                        {getArtifactTypeIcon(artifact.type)}
                      </span>
                      <div className="flex-1 min-w-0 text-left">
                        <p className="text-sm font-medium truncate">{artifact.title}</p>
                        <p className="text-xs text-muted-foreground">
                          {formatDistanceToNow(createdAt, { addSuffix: true })}
                        </p>
                      </div>
                      <Badge variant="outline" className="shrink-0 text-xs">
                        {t(`types.${TYPE_LABEL_KEYS[artifact.type]}`)}
                      </Badge>
                      {PREVIEWABLE_TYPES.includes(artifact.type) && (
                        <Badge variant="secondary" className="shrink-0 px-1">
                          <Eye className="h-3 w-3" />
                        </Badge>
                      )}
                    </div>
                  </Button>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem onClick={() => handleArtifactClick(artifact)}>
                    {t("open")}
                  </ContextMenuItem>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <ContextMenuItem
                          className="text-destructive"
                          onClick={(e) =>
                            handleDelete(artifact.id, e as unknown as React.MouseEvent)
                          }
                        >
                          <Trash2 className="h-4 w-4 mr-2" />
                          {t("delete")}
                        </ContextMenuItem>
                      </TooltipTrigger>
                      <TooltipContent side="right">
                        <p>{t("delete")}</p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </ContextMenuContent>
              </ContextMenu>
            )
          })}
        </div>
      </ScrollArea>

      {/* Delete Confirmation Dialog */}
      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {Array.isArray(pendingDelete)
                ? t("deleteConfirmBatchDesc", { count: pendingDelete.length })
                : t("deleteConfirmDesc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tArtifacts("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
