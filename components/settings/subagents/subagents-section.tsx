"use client"

/**
 * SubagentsSection — master/detail shell for the SubAgent feature.
 *
 * Replaces a long single-column scroll (two bordered policy blobs stacked over
 * a `templates | runtime` tab strip, a 2-column card grid, and a plugin list
 * appended at the bottom) with the house pattern every other heavy settings
 * section already uses: a grouped nav on the left, one panel on the right.
 * `subagents` is now a member of the shell's `FILL_HEIGHT_SECTIONS`, so this
 * component owns its own scroll and fills the frame.
 *
 * Two contracts worth keeping in view when editing:
 *
 *  - The detail HEADER sits outside `PanelTransition` on purpose. Under
 *    `mode="wait"` the incoming panel does not mount until the outgoing one
 *    has finished exiting, so a header inside it would flicker — and the FLIP
 *    ghost would have nothing to measure as its landing target.
 *  - `?focus=` is consumed here as well as by `use-setting-focus`. That hook
 *    finds its anchor with `document.querySelector`, which only works while
 *    the owning card is mounted; in a master/detail layout the section has to
 *    select the owning panel first or the finder's deep link silently stops
 *    highlighting anything.
 */

import { useCallback, useMemo, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { useTranslations } from "next-intl"
import { MenuIcon, NetworkIcon, PlusIcon } from "lucide-react"
import { nanoid } from "nanoid"

import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
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
import { PanelTransition } from "@/components/settings/common/panel-transition"
import {
  CLAUDE_CODE_RELATED,
  RelatedSectionsStrip,
} from "@/components/settings/common/related-sections-strip"
import { useSubagentRuntimeStore } from "@/stores/agent/subagent-runtime-store"
import { usePluginStore } from "@/stores/plugin-runtime"
import { listSubagentEntries } from "@/lib/plugin/registries/subagent-registry"
import type { SubAgentTemplate } from "@/types/agent/sub-agent"

import { SubagentsNav } from "./subagents-nav"
import { SubagentImportDialog } from "./subagent-import-dialog"
import { PanelDirtyProvider, usePanelDirty } from "./panel-dirty-context"
import { SubagentFlightGhost, FLIGHT_TARGET_ATTR } from "./motion/flight-ghost"
import { isRunning } from "./runtime-tree"
import {
  SUBAGENT_STATIC_GROUPS,
  panelForFocusId,
  parsePanelId,
  pluginPanelId,
  resolveSubagentPanel,
  templatePanelId,
  type SubagentNavEntityGroup,
  type SubagentPanelId,
} from "./nav-config"
import { NestingPanel, BackgroundPanel } from "./panels/policy-panels"
import { RuntimePanel } from "./panels/runtime-panel"
import { TemplatePanel } from "./panels/template-panel"
import { PluginPanel } from "./panels/plugin-panel"

/** Unchanged from the tabbed layout so pre-merge deep links keep resolving. */
const SUBAGENT_TAB_PARAM = "subagentTab"

const CATEGORIES: SubAgentTemplate["category"][] = [
  "research",
  "coding",
  "writing",
  "analysis",
  "general",
]

const glyphOf = (name: string, icon?: string): string =>
  icon?.charAt(0) || name.charAt(0).toUpperCase() || "?"

export function SubagentsSection() {
  return (
    <PanelDirtyProvider>
      <SubagentsSectionInner />
    </PanelDirtyProvider>
  )
}

function SubagentsSectionInner() {
  const t = useTranslations("settings.subagents")
  const tNav = useTranslations("settings.subagents.nav")
  const router = useRouter()
  const searchParams = useSearchParams()
  const dirty = usePanelDirty()

  const templates = useSubagentRuntimeStore((s) => s.templates)
  const addTemplate = useSubagentRuntimeStore((s) => s.addTemplate)
  const subAgents = useSubagentRuntimeStore((s) => s.subAgents)
  // The registry is a plain module, so it needs a reactive trigger: the plugin
  // store is what drives (un)registration. The previous list memoised on `[]`
  // and therefore never picked up a plugin enabled after first render.
  const plugins = usePluginStore((s) => s.plugins)
  // `plugins` is not read inside the factory, and that is deliberate: the
  // registry is a plain module with no subscription of its own, so the plugin
  // set is the only signal that its contents may have changed. Dropping the
  // dep is what froze the previous implementation on its first snapshot.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const pluginEntries = useMemo(() => listSubagentEntries(), [plugins])

  const [search, setSearch] = useState("")
  const [category, setCategory] = useState<string | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [importing, setImporting] = useState(false)
  const [pendingPanel, setPendingPanel] = useState<SubagentPanelId | null>(null)
  const [flying, setFlying] = useState(false)

  const sortedTemplates = useMemo(() => {
    return Object.values(templates).sort((a, b) => {
      const aBuilt = a.isBuiltIn ?? false
      const bBuilt = b.isBuiltIn ?? false
      if (aBuilt !== bBuilt) return aBuilt ? -1 : 1
      return a.name.localeCompare(b.name)
    })
  }, [templates])

  const runningCount = useMemo(() => Object.values(subAgents).filter(isRunning).length, [subAgents])

  const activePanel = useMemo(() => {
    const focusPanel = panelForFocusId(searchParams?.get("focus") ?? null)
    if (focusPanel) return focusPanel
    return resolveSubagentPanel(searchParams?.get(SUBAGENT_TAB_PARAM) ?? null, {
      templateIds: sortedTemplates.map((tpl) => tpl.id),
      pluginIds: pluginEntries.map((e) => (e.pluginId ? `${e.pluginId}:${e.id}` : e.id)),
    })
  }, [searchParams, sortedTemplates, pluginEntries])

  const navigate = useCallback(
    (panel: SubagentPanelId) => {
      const next = new URLSearchParams(searchParams?.toString() ?? "")
      next.set(SUBAGENT_TAB_PARAM, panel)
      router.replace(`?${next.toString()}`, { scroll: false })
      setSheetOpen(false)
    },
    [router, searchParams]
  )

  // Leaving a dirty panel discards its draft, so ask first.
  const onSelect = useCallback(
    (panel: SubagentPanelId) => {
      if (panel === activePanel) return
      if (dirty) {
        setPendingPanel(panel)
        return
      }
      navigate(panel)
    },
    [activePanel, dirty, navigate]
  )

  const matches = useCallback(
    (name: string, description: string) => {
      const q = search.trim().toLowerCase()
      if (!q) return true
      return name.toLowerCase().includes(q) || description.toLowerCase().includes(q)
    },
    [search]
  )

  const entityGroups = useMemo<SubagentNavEntityGroup[]>(() => {
    const builtin = sortedTemplates.filter((tpl) => tpl.isBuiltIn)
    const user = sortedTemplates.filter((tpl) => !tpl.isBuiltIn)
    const toItem = (tpl: SubAgentTemplate) => ({
      panelId: templatePanelId(tpl.id),
      label: tpl.name,
      description: tpl.description || undefined,
      glyph: glyphOf(tpl.name, tpl.icon),
      disabled: tpl.disabled,
      hidden: tpl.hidden,
    })
    const keep = (tpl: SubAgentTemplate) =>
      (!category || tpl.category === category) && matches(tpl.name, tpl.description)

    return [
      { id: "builtinGroup" as const, items: builtin.filter(keep).map(toItem) },
      { id: "userGroup" as const, items: user.filter(keep).map(toItem) },
      {
        id: "pluginGroup" as const,
        // Plugin entries carry no category, so a category filter hides them.
        items: category
          ? []
          : pluginEntries
              .filter((e) => matches(e.entry.name, e.entry.description ?? ""))
              .map((e) => {
                const runtimeId = e.pluginId ? `${e.pluginId}:${e.id}` : e.id
                return {
                  panelId: pluginPanelId(runtimeId),
                  label: e.entry.name,
                  description: e.pluginId,
                  glyph: glyphOf(e.entry.name),
                  disabled: e.entry.disabled,
                  hidden: e.entry.hidden,
                }
              }),
      },
    ]
  }, [sortedTemplates, pluginEntries, category, matches])

  const filteredEmpty =
    (search.trim().length > 0 || category !== null) &&
    entityGroups.every((g) => g.items.length === 0)

  const createTemplate = useCallback(() => {
    const draft: SubAgentTemplate = {
      id: nanoid(),
      name: t("templates.newTemplate"),
      description: "",
      category: "general",
      taskTemplate: "",
      config: {},
      isBuiltIn: false,
      createdAt: new Date(),
    }
    addTemplate(draft)
    navigate(templatePanelId(draft.id))
  }, [addTemplate, navigate, t])

  const parsed = parsePanelId(activePanel)
  const header = headerFor(parsed, { templates, pluginEntries, tNav })

  const navNode = (
    <SubagentsNav
      activeId={activePanel}
      onSelect={onSelect}
      entityGroups={entityGroups}
      runningCount={runningCount}
      dirtyPanels={dirty ? [activePanel] : []}
      search={search}
      onSearchChange={setSearch}
      categories={CATEGORIES}
      activeCategory={category}
      onCategoryChange={setCategory}
      filteredEmpty={filteredEmpty}
    />
  )

  return (
    <div className="flex h-full min-h-0 flex-col gap-4" data-testid="subagents-section">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <Label className="flex items-center gap-2">
            <NetworkIcon className="size-4" />
            {t("title")}
          </Label>
          <p className="text-xs text-muted-foreground">{t("description")}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setImporting(true)}
            data-testid="subagent-template-import"
          >
            {t("import.trigger")}
          </Button>
          <Button size="sm" onClick={createTemplate} data-testid="subagent-template-new">
            <PlusIcon className="mr-1.5 size-4" />
            {t("templates.newTemplate")}
          </Button>
        </div>
      </div>

      <RelatedSectionsStrip current="subagents" targets={CLAUDE_CODE_RELATED} />

      <SubagentImportDialog open={importing} onOpenChange={setImporting} onImported={() => {}} />

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 md:grid-cols-[300px_1fr]">
        <div className="hidden min-h-0 md:flex md:flex-col md:overflow-hidden md:rounded-lg md:border">
          {navNode}
        </div>

        <div className="flex items-center gap-2 md:hidden">
          <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
            <SheetTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="shrink-0 gap-1.5"
                data-testid="subagent-mobile-nav-trigger"
              >
                <MenuIcon className="size-4" />
                {tNav("mobileTrigger")}
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="flex w-[300px] flex-col p-0">
              <SheetHeader className="px-3 pt-3">
                <SheetTitle className="text-sm">{tNav("title")}</SheetTitle>
              </SheetHeader>
              {navNode}
            </SheetContent>
          </Sheet>
          <p className="min-w-0 flex-1 truncate text-sm font-medium">{header.title}</p>
        </div>

        <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border">
          {/* Outside PanelTransition — see the file header. */}
          <div className="flex shrink-0 items-center gap-2 border-b p-3">
            <span
              {...{ [FLIGHT_TARGET_ATTR]: "" }}
              className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs transition-opacity"
              style={{ opacity: flying ? 0 : 1 }}
              aria-hidden
            >
              {header.glyph}
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{header.title}</p>
              {header.subtitle ? (
                <p className="truncate text-[11px] text-muted-foreground">{header.subtitle}</p>
              ) : null}
            </div>
          </div>

          <div
            className="min-h-0 flex-1 overflow-y-auto p-3 @container/subagent-pane"
            data-testid="subagent-panel-body"
          >
            <PanelTransition activeKey={activePanel}>
              {renderPanel(activePanel, {
                onNavigate: (id) => navigate(templatePanelId(id)),
                pluginEntries,
              })}
            </PanelTransition>
          </div>
        </div>
      </div>

      <SubagentFlightGhost activePanel={activePanel} onFlightChange={setFlying}>
        <span className="flex size-7 items-center justify-center rounded-full bg-primary/10 text-xs">
          {header.glyph}
        </span>
      </SubagentFlightGhost>

      <AlertDialog
        open={pendingPanel !== null}
        onOpenChange={(open) => !open && setPendingPanel(null)}
      >
        <AlertDialogContent data-testid="subagent-discard-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("discardTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("discardBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("discardStay")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingPanel) navigate(pendingPanel)
                setPendingPanel(null)
              }}
              data-testid="subagent-discard-confirm-action"
            >
              {t("discardLeave")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

type PluginEntries = ReturnType<typeof listSubagentEntries>

function renderPanel(
  panel: SubagentPanelId,
  ctx: { onNavigate: (templateId: string) => void; pluginEntries: PluginEntries }
) {
  const parsed = parsePanelId(panel)
  if (parsed.kind === "template") {
    return <TemplatePanel templateId={parsed.id} onNavigate={ctx.onNavigate} />
  }
  if (parsed.kind === "plugin") {
    const found = ctx.pluginEntries.find(
      (e) => (e.pluginId ? `${e.pluginId}:${e.id}` : e.id) === parsed.id
    )
    return <PluginPanel runtimeId={parsed.id} entry={found?.entry} pluginId={found?.pluginId} />
  }
  switch (parsed.id) {
    case "runtime":
      return <RuntimePanel />
    case "nesting":
      return <NestingPanel />
    case "background":
      return <BackgroundPanel />
  }
}

/** Lucide icon for each static panel, so its header matches its nav row. */
const STATIC_ICONS = new Map(
  SUBAGENT_STATIC_GROUPS.flatMap((g) => g.items.map((i) => [i.id, i.icon] as const))
)

function headerFor(
  parsed: ReturnType<typeof parsePanelId>,
  ctx: {
    templates: Record<string, SubAgentTemplate>
    pluginEntries: PluginEntries
    tNav: ReturnType<typeof useTranslations>
  }
): { title: string; subtitle?: string; glyph: React.ReactNode } {
  if (parsed.kind === "template") {
    const tpl = ctx.templates[parsed.id]
    if (tpl) {
      return {
        title: tpl.name,
        subtitle: tpl.description || undefined,
        glyph: glyphOf(tpl.name, tpl.icon),
      }
    }
  }
  if (parsed.kind === "plugin") {
    const found = ctx.pluginEntries.find(
      (e) => (e.pluginId ? `${e.pluginId}:${e.id}` : e.id) === parsed.id
    )
    if (found) {
      return {
        title: found.entry.name,
        subtitle: found.pluginId,
        glyph: glyphOf(found.entry.name),
      }
    }
  }
  const id = parsed.kind === "static" ? parsed.id : "nesting"
  const Icon = STATIC_ICONS.get(id)
  return {
    title: ctx.tNav(`items.${id}.label`),
    subtitle: ctx.tNav(`items.${id}.description`),
    glyph: Icon ? <Icon className="size-3.5" /> : null,
  }
}

export default SubagentsSection
