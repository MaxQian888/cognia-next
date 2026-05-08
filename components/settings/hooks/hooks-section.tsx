"use client"

/**
 * HooksSection — settings panel for the `hooks` block of `~/.claude/settings.json`.
 *
 * Phase 5 of the ClaudeCode 完整化 plan. Three scopes (User / Project / Local)
 * map onto the three reader/writer pairs in `lib/claude/settings.ts`. Within
 * a scope, the panel splits into the 21 `HookEvent` values from
 * `lib/claude/hooks.ts`. Each event hosts a list of `HookGroup` editors.
 *
 * The full settings payload is round-tripped — read → patch.hooks → write —
 * so unknown top-level keys (everything in `extra`) and other scope blocks
 * (model, permissions, mcpServers) survive untouched. The Rust writer's
 * `extra` flatten map carries them through.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { useRouter, useSearchParams } from "next/navigation"
import { PlusIcon, RotateCcwIcon, SaveIcon } from "lucide-react"
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
import { HookGroupEditor, validateMatcher } from "./hook-group-editor"
import { createLogger } from "@/lib/logger"
import {
  CLAUDE_CODE_RELATED,
  RelatedSectionsStrip,
} from "@/components/settings/common/related-sections-strip"

const log = createLogger("settings.hooks")

type Scope = "user" | "project" | "local"

/** Every lifecycle event the Rust hooks runtime knows about. */
const HOOK_EVENTS: HookEvent[] = [
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "Stop",
  "SubagentStop",
  "SessionStart",
  "SessionEnd",
  "Notification",
  "PreCompact",
  "PostCompact",
  "TaskCreated",
  "TaskCompleted",
  "PermissionRequest",
  "PermissionDenied",
  "WorktreeCreate",
  "WorktreeRemove",
  "FileChanged",
  "CwdChanged",
  "InstructionsLoaded",
  "ConfigChange",
  "Elicitation",
  "ElicitationResult",
  "PostToolBatch",
  "PostToolUseFailure",
  "StopFailure",
  "TeammateIdle",
  "UserPromptExpansion",
]

interface Props {
  /** Override for tests — when omitted, the project/local scopes use this cwd. */
  cwd?: string
}

export function HooksSection({ cwd }: Props) {
  const t = useTranslations("settings.hooks")
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

  return (
    <div className="space-y-4" data-testid="hooks-section">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">{t("title")}</h2>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>

      <RelatedSectionsStrip current="hooks" targets={CLAUDE_CODE_RELATED} />

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
          <ScrollArea className="max-h-64">
            <div className="grid grid-cols-3 gap-1 sm:grid-cols-4 md:grid-cols-5">
              {HOOK_EVENTS.map((evt) => {
                const count = (draft[evt] ?? []).length
                return (
                  <Button
                    key={evt}
                    variant={activeEvent === evt ? "secondary" : "ghost"}
                    size="sm"
                    onClick={() => setActiveEvent(evt)}
                    className="justify-start text-xs"
                    data-testid={`event-tab-${evt}`}
                    data-active={activeEvent === evt ? "true" : "false"}
                  >
                    <span className="truncate">{evt}</span>
                    {count > 0 ? (
                      <span className="ml-auto rounded bg-primary/15 px-1 text-[10px]">
                        {count}
                      </span>
                    ) : null}
                  </Button>
                )
              })}
            </div>
          </ScrollArea>
        </Card>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium">{activeEvent}</h3>
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
              {t("noGroupsForEvent", { event: activeEvent })}
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
