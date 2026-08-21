"use client"

/**
 * The Squads library: rail on the left, one Squad (or the template gallery)
 * on the right.
 *
 * A Squad is a cross-conversation asset, like an MCP server or a model
 * provider — which is where the other assets of that kind already live. It
 * used to have a top-level route of its own that also carried run state, a
 * chat tab, a kanban board and eleven accordions of governance, and could not
 * be read as any one thing.
 *
 * Structure copied from `components/settings/subagents/subagents-section.tsx`,
 * including the two contracts that are easy to get wrong: the detail header
 * lives OUTSIDE the transition (under `mode="wait"` the incoming panel does
 * not mount until the outgoing one leaves, so a header inside would flicker),
 * and `?focus=` is consumed HERE — `use-setting-focus` scrolls to a
 * `[data-setting-id]` anchor that only exists once its owning panel is
 * mounted.
 */

import { Suspense, useCallback, useEffect, useMemo, useState } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { useTranslations } from "next-intl"
import { MenuIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { PanelTransition } from "@/components/settings/common/panel-transition"
import { AgentTeamTemplatesSection } from "@/components/settings/agent/agent-team-templates-section"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { useUIStore } from "@/stores/ui/ui-store"
import {
  SQUAD_TAB_PARAM,
  parseSquadPanelId,
  resolveSquadPanel,
  squadPanelForFocusId,
  squadPanelId,
  type SquadPanelId,
} from "./nav-config"
import { SquadsNav } from "./squads-nav"
import { SquadDetailPanel } from "./squad-detail-panel"

function SquadsSectionInner() {
  const t = useTranslations("settings.squads")
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [sheetOpen, setSheetOpen] = useState(false)

  const teams = useAgentTeamStore((s) => s.teams)
  const teammates = useAgentTeamStore((s) => s.teammates)
  const createTeam = useAgentTeamStore((s) => s.createTeam)

  const squads = useMemo(
    () =>
      Object.values(teams)
        .map((team) => ({
          id: team.id,
          name: team.name,
          memberCount: Object.values(teammates).filter((m) => m.teamId === team.id).length,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [teams, teammates]
  )

  const activePanel = useMemo(() => {
    const focusPanel = squadPanelForFocusId(searchParams?.get("focus") ?? null)
    if (focusPanel) return focusPanel
    return resolveSquadPanel(searchParams?.get(SQUAD_TAB_PARAM) ?? null, {
      squadIds: squads.map((s) => s.id),
    })
  }, [searchParams, squads])

  const navigate = useCallback(
    (panel: SquadPanelId) => {
      const next = new URLSearchParams(searchParams?.toString() ?? "")
      next.set(SQUAD_TAB_PARAM, panel)
      // Relative, so `?section=squads` and anything else on the URL survives.
      router.replace(`${pathname}?${next.toString()}`, { scroll: false })
      setSheetOpen(false)
    },
    [router, pathname, searchParams]
  )

  const handleCreate = useCallback(() => {
    const squad = createTeam({
      name: t("nav.newSquadName"),
      task: "",
      leadName: t("nav.defaultLeadName"),
    })
    navigate(squadPanelId(squad.id))
  }, [createTeam, navigate, t])

  // `File > New Squad` fires a create request and routes here. Without a
  // consumer the menu item would land on the library and do nothing.
  const pendingCreate = useUIStore((s) => s.pendingCreateRequest)
  const clearPendingCreate = useUIStore((s) => s.clearPendingCreate)
  useEffect(() => {
    if (pendingCreate?.kind !== "agentTeam") return
    clearPendingCreate()
    // Intentional bridge from the Zustand create signal to a store write plus
    // navigation. The signal originates outside React (a native menu event),
    // so there is no render-time path to react to it; the page this replaces
    // bridged it the same way.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    handleCreate()
  }, [pendingCreate, clearPendingCreate, handleCreate])

  const parsed = parseSquadPanelId(activePanel)
  const activeSquad = parsed.kind === "squad" ? teams[parsed.id] : undefined
  const headerTitle =
    parsed.kind === "squad"
      ? (activeSquad?.name ?? t("detail.missingTitle"))
      : t("nav.static.templates")

  const nav = (
    <SquadsNav
      squads={squads}
      activePanel={activePanel}
      onSelect={navigate}
      onCreate={handleCreate}
    />
  )

  return (
    <div
      className="grid min-h-0 flex-1 grid-cols-1 gap-4 md:grid-cols-[300px_minmax(0,1fr)]"
      data-testid="squads-section"
    >
      <div className="hidden min-h-0 md:flex md:flex-col md:overflow-hidden md:rounded-lg md:border">
        {nav}
      </div>

      <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border">
        {/* Outside PanelTransition on purpose — see the file header. */}
        <div className="flex shrink-0 items-center gap-2 border-b p-3">
          <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
            <SheetTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="md:hidden"
                aria-label={t("nav.openList")}
                data-testid="squads-nav-sheet-trigger"
              >
                <MenuIcon className="size-4" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-[300px] p-0">
              <SheetTitle className="sr-only">{t("nav.openList")}</SheetTitle>
              {nav}
            </SheetContent>
          </Sheet>
          <span className="min-w-0 truncate text-sm font-medium">{headerTitle}</span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <PanelTransition activeKey={activePanel}>
            {parsed.kind === "squad" ? (
              <SquadDetailPanel
                squadId={parsed.id}
                onDeleted={() => {
                  // Land on a neighbour rather than a pane addressing a Squad
                  // that no longer exists.
                  const next = squads.find((s) => s.id !== parsed.id)
                  navigate(next ? squadPanelId(next.id) : "templates")
                }}
              />
            ) : (
              <AgentTeamTemplatesSection />
            )}
          </PanelTransition>
        </div>
      </div>
    </div>
  )
}

/** `useSearchParams` requires a Suspense boundary under `output: "export"`. */
export function SquadsSection() {
  return (
    <Suspense fallback={null}>
      <SquadsSectionInner />
    </Suspense>
  )
}

export default SquadsSection
