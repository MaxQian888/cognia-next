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
  WrenchIcon,
  type LucideProps,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ScrollArea } from "@/components/ui/scroll-area"
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
  HOOK_EVENTS,
  HOOK_EVENT_CATEGORIES,
  hookEventsByCategory,
  isDormantEvent,
  type HookEventCategory,
} from "@/lib/claude/hooks/event-catalog"
import { cn } from "@/lib/utils"
import { HookGroupEditor, validateMatcher } from "./hook-group-editor"
import { BuiltinHooksCard } from "./builtin-hooks-card"
import { createLogger } from "@/lib/logging"
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
}

export function HooksSection({ cwd }: Props) {
  const t = useTranslations("settings.hooks")
  // Localized event labels / descriptions / category names live in the shared
  // `hooks` namespace (single catalog source), alongside the chat hook-notice.
  const tc = useTranslations("hooks")
  const router = useRouter()
  const searchParams = useSearchParams()

  const [scope, setScope] = useState<Scope>("user")
  // Full settings doc per scope so we round-trip extras + permissions + …
  const [doc, setDoc] = useState<ClaudeSettings | null>(null)
  // Live (possibly dirty) hooks block.
  const [draft, setDraft] = useState<HooksConfig>({})
  // Last-saved snapshot used as the dirty-comparison baseline.
  const [initialDoc, setInitialDoc] = useState<HooksConfig>({})
  const [saving, setSaving] = useState(false)

  const activeEvent = useMemo<HookEvent>(() => {
    const param = searchParams?.get("hookTab")
    return (HOOK_EVENTS.find((e) => e === param) as HookEvent | undefined) ?? "PreToolUse"
  }, [searchParams])

  const setActiveEvent = useCallback(
    (evt: HookEvent) => {
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

  // Group-level validity gate for the Save button.
  const invalid = useMemo(() => {
    for (const event of Object.keys(draft) as HookEvent[]) {
      const groups = draft[event] ?? []
      for (const g of groups) {
        if (validateMatcher(g.matcher)) return true
      }
    }
    return false
  }, [draft])

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
    <div className="space-y-4" data-testid="hooks-section">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">{t("title")}</h2>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>

      <RelatedSectionsStrip current="hooks" targets={CLAUDE_CODE_RELATED} />

      <BuiltinHooksCard />

      <Tabs value={scope} onValueChange={(v) => setScope(v as Scope)}>
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

      <div className="space-y-3">
        <div className="flex items-center justify-end gap-2">
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

        <Card className="p-2">
          <ScrollArea className="max-h-72">
            <div className="space-y-3">
              {HOOK_EVENT_CATEGORIES.map((cat) => {
                const CatIcon = CATEGORY_ICONS[cat]
                return (
                  <div key={cat} className="space-y-1" data-testid={`event-category-${cat}`}>
                    <div className="flex items-center gap-1.5 px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                      <CatIcon className="size-3 shrink-0" aria-hidden />
                      {tc(`categories.${cat}`)}
                    </div>
                    <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
                      {eventsByCategory[cat].map((meta) => {
                        const evt = meta.event
                        const count = (draft[evt] ?? []).length
                        return (
                          <Button
                            key={evt}
                            variant={activeEvent === evt ? "secondary" : "ghost"}
                            size="sm"
                            onClick={() => setActiveEvent(evt)}
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
          </ScrollArea>
        </Card>

        <div className="space-y-2">
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

          {groupsForActive.length === 0 ? (
            <p
              className="rounded border bg-muted/30 p-4 text-center text-xs italic text-muted-foreground"
              data-testid="hooks-empty"
            >
              {t("noGroupsForEvent", { event: tc(`events.${activeEvent}.label`) })}
            </p>
          ) : (
            groupsForActive.map((g, i) => (
              <HookGroupEditor
                key={i}
                value={g}
                onChange={(next) => updateGroup(activeEvent, i, next)}
                onRemove={() => removeGroup(activeEvent, i)}
              />
            ))
          )}
        </div>
      </div>
    </div>
  )
}

export default HooksSection
