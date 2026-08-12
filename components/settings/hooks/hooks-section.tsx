"use client"

/**
 * HooksSection — settings panel for the `hooks` block of `~/.claude/settings.json`.
 *
 * Phase 5 of the ClaudeCode 完整化 plan. Three scopes (User / Project / Local)
 * map onto the three reader/writer pairs in `lib/claude/settings.ts`. Within
 * a scope, the panel groups every `HookEvent` by lifecycle category from the
 * shared `lib/claude/hooks/event-catalog.ts` (the single source of truth shared
 * with the chat hook-notice row). Each event hosts a list of `HookGroup` editors.
 *
 * Layout is master–detail: the category-grouped event list is a sticky left
 * column on wide panes and collapses above the editor on narrow ones (container
 * queries on `@container/hooks-pane`). The section fills the settings frame
 * (registered in `FILL_HEIGHT_SECTIONS`) and owns its own scroll.
 *
 * The full settings payload is round-tripped — read → patch.hooks → write —
 * so unknown top-level keys (everything in `extra`) and other scope blocks
 * (model, permissions, mcpServers) survive untouched. The Rust writer's
 * `extra` flatten map carries them through.
 */

import type { ComponentType } from "react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { useRouter, useSearchParams } from "next/navigation"
import {
  ActivityIcon,
  ListChecksIcon,
  MessagesSquareIcon,
  PlusIcon,
  RotateCcwIcon,
  SaveIcon,
  ShieldIcon,
  WebhookIcon,
  WrenchIcon,
  type LucideProps,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
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
import { SettingsEmptyState } from "@/components/settings/common/settings-section"
import { toast } from "@/components/ui/sonner"
import {
  readClaudeUserSettings,
  readClaudeProjectSettings,
  readClaudeLocalSettings,
  writeClaudeUserSettings,
  writeClaudeProjectSettings,
  writeClaudeLocalSettings,
  type ClaudeSettings,
} from "@/lib/claude/settings"
import type { HookEvent, HookGroup, HooksConfig } from "@/lib/claude/hooks"
import {
  knownHookRuntimeCapabilities,
  type HookRuntimeCapabilities,
} from "@/lib/claude/hooks/runtime-capabilities"
import {
  HOOK_EVENTS,
  HOOK_EVENT_CATEGORIES,
  hookEventsByCategory,
  isDormantEvent,
  type HookEventCategory,
} from "@/lib/claude/hooks/event-catalog"
import { cn } from "@/lib/utils"
import { HookGroupEditor, validateMatcher } from "./hook-group-editor"
import { validateHandler } from "./hook-handler-form"
import { BuiltinHooksCard } from "./builtin-hooks-card"
import { hookRuntimeCapability } from "@/lib/claude/hooks/capabilities"
import { createLogger } from "@cognia/logging"
import {
  CLAUDE_CODE_RELATED,
  RelatedSectionsStrip,
} from "@/components/settings/common/related-sections-strip"

const log = createLogger("settings.hooks")

type Scope = "user" | "project" | "local"

// Per-category icon for the grouped event picker (purely presentational, so it
// lives here rather than in the pure-data catalog module).
const CATEGORY_ICONS: Record<HookEventCategory, ComponentType<LucideProps>> = {
  tools: WrenchIcon,
  session: MessagesSquareIcon,
  permissions: ShieldIcon,
  tasks: ListChecksIcon,
  lifecycle: ActivityIcon,
}

interface Props {
  /** Override for tests — when omitted, the project/local scopes use this cwd. */
  cwd?: string
  runtimeCapabilities?: HookRuntimeCapabilities
}

const DEFAULT_RUNTIME_CAPABILITIES = knownHookRuntimeCapabilities("claude")

export function HooksSection({ cwd, runtimeCapabilities = DEFAULT_RUNTIME_CAPABILITIES }: Props) {
  const t = useTranslations("settings.hooks")
  // Localized event labels / descriptions / category names live in the shared
  // `hooks` namespace (single catalog source), alongside the chat hook-notice.
  const tc = useTranslations("hooks")
  const router = useRouter()
  const searchParams = useSearchParams()
  const runtimeCapability = hookRuntimeCapability("claude-agent-sdk")

  const [scope, setScope] = useState<Scope>("user")
  // Full settings doc per scope so we round-trip extras + permissions + …
  const [doc, setDoc] = useState<ClaudeSettings | null>(null)
  // Live (possibly dirty) hooks block.
  const [draft, setDraft] = useState<HooksConfig>({})
  // Last-saved snapshot used as the dirty-comparison baseline.
  const [initialDoc, setInitialDoc] = useState<HooksConfig>({})
  const [saving, setSaving] = useState(false)
  // Pending scope tab awaiting confirmation because the draft is dirty.
  const [pendingScope, setPendingScope] = useState<Scope | null>(null)
  // Index of a just-added group in the active event, so its matcher autofocuses.
  const [autoFocusIdx, setAutoFocusIdx] = useState<number | null>(null)

  const activeEvent = useMemo<HookEvent>(() => {
    const param = searchParams?.get("hookTab")
    return (HOOK_EVENTS.find((e) => e === param) as HookEvent | undefined) ?? "PreToolUse"
  }, [searchParams])

  const selectEvent = useCallback(
    (evt: HookEvent) => {
      setAutoFocusIdx(null)
      const next = new URLSearchParams(searchParams?.toString() ?? "")
      next.set("hookTab", evt)
      router.replace(`?${next.toString()}`, { scroll: false })
    },
    [router, searchParams]
  )

  // Async load on cwd/scope change. setState only runs after the awaited read
  // resolves (and only when the effect hasn't been cancelled), which keeps
  // the `react-hooks/set-state-in-effect` rule happy.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const cwdValue = cwd ?? ""
        const loaded =
          scope === "user"
            ? await readClaudeUserSettings()
            : scope === "project"
              ? cwdValue
                ? await readClaudeProjectSettings(cwdValue)
                : null
              : cwdValue
                ? await readClaudeLocalSettings(cwdValue)
                : null
        if (cancelled) return
        const settings = loaded ?? {}
        const hooks = (settings.hooks ?? {}) as HooksConfig
        setDoc(settings)
        setDraft(structuredClone(hooks))
        setInitialDoc(structuredClone(hooks))
      } catch (e) {
        if (cancelled) return
        log.error("load_failed", { scope, error: String(e) })
        toast.error(t("loadError", { detail: String(e) }))
      }
    })()
    return () => {
      cancelled = true
    }
    // `t` from next-intl is referentially stable; intentionally excluded from
    // deps so a parent re-render doesn't refire the read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, scope])

  const dirty = useMemo(() => {
    return JSON.stringify(initialDoc) !== JSON.stringify(draft)
  }, [draft, initialDoc])

  // Group-level validity gate for the Save button: an invalid matcher regex or
  // an un-runnable handler (empty command / bad URL) both block the save.
  const invalid = useMemo(() => {
    for (const event of Object.keys(draft) as HookEvent[]) {
      const groups = draft[event] ?? []
      for (const g of groups) {
        if (validateMatcher(g.matcher)) return true
        for (const h of g.hooks) {
          if (validateHandler(h)) return true
        }
      }
    }
    return false
  }, [draft])

  // Total configured groups across every event in the current scope.
  const totalGroups = useMemo(
    () => Object.values(draft).reduce((n, groups) => n + (groups?.length ?? 0), 0),
    [draft]
  )

  const setEventGroups = (event: HookEvent, groups: HookGroup[]) => {
    setDraft((prev) => {
      const next = { ...prev }
      if (groups.length === 0) {
        delete next[event]
      } else {
        next[event] = groups
      }
      return next
    })
  }

  const addGroup = (event: HookEvent) => {
    const groups = [...(draft[event] ?? [])]
    groups.push({ matcher: "", hooks: [] })
    setEventGroups(event, groups)
    setAutoFocusIdx(groups.length - 1)
  }

  const updateGroup = (event: HookEvent, idx: number, next: HookGroup) => {
    const groups = [...(draft[event] ?? [])]
    groups[idx] = next
    setEventGroups(event, groups)
  }

  const removeGroup = (event: HookEvent, idx: number) => {
    const groups = [...(draft[event] ?? [])].filter((_, i) => i !== idx)
    setEventGroups(event, groups)
  }

  // Scope switch is guarded when there are unsaved edits — reloading a new
  // scope resets `draft`, so we confirm before discarding.
  const requestScope = (next: Scope) => {
    if (next === scope) return
    if (dirty) {
      setPendingScope(next)
    } else {
      setAutoFocusIdx(null)
      setScope(next)
    }
  }

  const confirmScopeSwitch = () => {
    if (pendingScope) {
      setAutoFocusIdx(null)
      setScope(pendingScope)
    }
    setPendingScope(null)
  }

  const save = async () => {
    if (saving || !doc) return
    setSaving(true)
    try {
      // Write the FULL settings payload back: only `hooks` changes; everything
      // else (`extra`, `permissions`, `mcpServers`, `model`) stays as read.
      const payload: ClaudeSettings = {
        ...doc,
        hooks: Object.keys(draft).length === 0 ? undefined : (draft as Record<string, unknown>),
      }
      const cwdValue = cwd ?? ""
      if (scope === "user") {
        await writeClaudeUserSettings(payload)
      } else if (scope === "project") {
        if (!cwdValue) throw new Error("Project scope requires a cwd")
        await writeClaudeProjectSettings(cwdValue, payload)
      } else {
        if (!cwdValue) throw new Error("Local scope requires a cwd")
        await writeClaudeLocalSettings(cwdValue, payload)
      }
      setInitialDoc(structuredClone(draft))
      toast.success(t("saved"))
    } catch (e) {
      log.error("save_failed", { scope, error: String(e) })
      toast.error(t("saveError", { detail: String(e) }))
    } finally {
      setSaving(false)
    }
  }

  const revert = () => {
    setDraft(structuredClone(initialDoc))
  }

  const groupsForActive = draft[activeEvent] ?? []
  // Catalog is static; partition once per mount for the grouped event picker.
  const eventsByCategory = useMemo(() => hookEventsByCategory(), [])

  return (
    <div
      className="flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden"
      data-testid="hooks-section"
    >
      {/* Header + action bar — always visible above the scrolling body. */}
      <div className="flex shrink-0 flex-wrap items-start justify-between gap-2 pb-3">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold">{t("title")}</h2>
            <Badge variant="outline" className="text-[10px]" data-testid="hooks-runtime">
              {t("runtimeSummary", {
                version: runtimeCapability.version,
                count: runtimeCapability.events.length,
              })}
            </Badge>
            {totalGroups > 0 ? (
              <Badge variant="secondary" className="text-[10px]" data-testid="hooks-summary">
                {t("summary", { count: totalGroups })}
              </Badge>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">{t("description")}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {dirty ? (
            <span
              className="flex items-center gap-1.5 text-xs font-medium text-amber-600 dark:text-amber-500"
              data-testid="hooks-unsaved"
            >
              <span className="size-1.5 rounded-full bg-current" aria-hidden />
              {t("unsaved")}
            </span>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            onClick={revert}
            disabled={!dirty || saving}
            data-testid="hooks-revert"
          >
            <RotateCcwIcon className="mr-1.5 size-3.5" />
            {t("revert")}
          </Button>
          <Button
            size="sm"
            onClick={save}
            disabled={!dirty || saving || invalid}
            data-testid="hooks-save"
          >
            <SaveIcon className="mr-1.5 size-3.5" />
            {saving ? t("saving") : t("save")}
          </Button>
        </div>
      </div>

      {/* Fixed settings region: only the event list below owns vertical scrolling. */}
      <div
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden pr-0.5 @container/hooks-pane"
        data-testid="hooks-settings-region"
      >
        <div className="shrink-0 space-y-3">
          <RelatedSectionsStrip current="hooks" targets={CLAUDE_CODE_RELATED} />

          <BuiltinHooksCard />

          <Tabs value={scope} onValueChange={(v) => requestScope(v as Scope)}>
            <TabsList>
              <TabsTrigger value="user" data-testid="scope-user">
                {t("scope.user")}
              </TabsTrigger>
              <TabsTrigger value="project" data-testid="scope-project" disabled={!cwd}>
                {t("scope.project")}
              </TabsTrigger>
              <TabsTrigger value="local" data-testid="scope-local" disabled={!cwd}>
                {t("scope.local")}
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden @3xl/hooks-pane:flex-row @3xl/hooks-pane:gap-4">
          {/* Left: category-grouped event list. */}
          <div
            aria-label={t("eventListLabel")}
            className={cn(
              "max-h-64 min-h-0 space-y-3 overflow-y-auto rounded-lg border bg-muted/20 p-2",
              "@3xl/hooks-pane:h-full @3xl/hooks-pane:max-h-none @3xl/hooks-pane:w-60 @3xl/hooks-pane:shrink-0"
            )}
          >
            {HOOK_EVENT_CATEGORIES.map((cat) => {
              const CatIcon = CATEGORY_ICONS[cat]
              return (
                <div key={cat} className="space-y-1" data-testid={`event-category-${cat}`}>
                  <div className="flex items-center gap-1.5 px-1 text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
                    <CatIcon className="size-3 shrink-0" aria-hidden />
                    {tc(`categories.${cat}`)}
                  </div>
                  <div className="grid grid-cols-2 gap-1 @xl/hooks-pane:grid-cols-3 @3xl/hooks-pane:grid-cols-1">
                    {eventsByCategory[cat].map((meta) => {
                      const evt = meta.event
                      const count = (draft[evt] ?? []).length
                      return (
                        <Button
                          key={evt}
                          variant={activeEvent === evt ? "secondary" : "ghost"}
                          size="sm"
                          onClick={() => selectEvent(evt)}
                          className="justify-start gap-1.5 text-xs"
                          data-testid={`event-tab-${evt}`}
                          data-active={activeEvent === evt ? "true" : "false"}
                        >
                          <span
                            className={cn(
                              "truncate",
                              meta.dormant && "italic text-muted-foreground"
                            )}
                          >
                            {tc(`events.${evt}.label`)}
                          </span>
                          <span className="ml-auto flex shrink-0 items-center gap-1">
                            {meta.dormant ? (
                              <span
                                className="size-1.5 rounded-full bg-muted-foreground/40"
                                title={t("noTriggerBadge")}
                                data-testid={`event-no-trigger-${evt}`}
                              />
                            ) : null}
                            {count > 0 ? (
                              <span className="rounded bg-primary/15 px-1 text-[10px]">
                                {count}
                              </span>
                            ) : null}
                          </span>
                        </Button>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>

          {/* Right: editor for the active event. */}
          <div className="min-h-0 min-w-0 flex-1 space-y-2 overflow-hidden">
            {isDormantEvent(activeEvent) ? (
              <p
                className="rounded border border-dashed bg-muted/20 p-2 text-xs text-muted-foreground"
                data-testid="hooks-no-trigger-note"
              >
                {t("noTriggerNote")}
              </p>
            ) : null}

            <div className="flex items-start justify-between gap-3">
              <div className="space-y-0.5">
                <h3 className="text-sm font-medium" data-testid="hooks-active-event">
                  {tc(`events.${activeEvent}.label`)}
                </h3>
                <p className="text-xs text-muted-foreground" data-testid="hooks-active-event-desc">
                  {tc(`events.${activeEvent}.desc`)}
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => addGroup(activeEvent)}
                data-testid="hooks-add-group"
              >
                <PlusIcon className="mr-1 size-3.5" />
                {t("addGroup")}
              </Button>
            </div>

            {doc === null ? (
              <div className="space-y-2" data-testid="hooks-loading" aria-label={t("loading")}>
                <Skeleton className="h-4 w-64" />
                <Skeleton className="h-24 w-full" />
              </div>
            ) : groupsForActive.length === 0 ? (
              <div data-testid="hooks-empty">
                <SettingsEmptyState
                  icon={<WebhookIcon className="size-5" aria-hidden />}
                  title={t("noGroupsForEvent", { event: tc(`events.${activeEvent}.label`) })}
                />
              </div>
            ) : (
              groupsForActive.map((g, i) => (
                <HookGroupEditor
                  key={i}
                  value={g}
                  autoFocus={i === autoFocusIdx}
                  onChange={(next) => updateGroup(activeEvent, i, next)}
                  onRemove={() => removeGroup(activeEvent, i)}
                  supportedHandlerTypes={runtimeCapabilities.handlerTypes}
                />
              ))
            )}
          </div>
        </div>
      </div>

      <AlertDialog
        open={pendingScope !== null}
        onOpenChange={(open) => {
          if (!open) setPendingScope(null)
        }}
      >
        <AlertDialogContent data-testid="hooks-scope-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("confirmSwitch.title")}</AlertDialogTitle>
            <AlertDialogDescription>{t("confirmSwitch.description")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="hooks-scope-cancel">
              {t("confirmSwitch.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction onClick={confirmScopeSwitch} data-testid="hooks-scope-discard">
              {t("confirmSwitch.discard")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

export default HooksSection
