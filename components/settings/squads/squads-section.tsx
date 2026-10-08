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
import Link from "next/link"
import { ArrowUpRightIcon } from "lucide-react"

import { StatusBadge } from "@/components/status-badge"
import { Button } from "@/components/ui/button"
import { PanelTransition } from "@/components/settings/common/panel-transition"
import {
  SETTINGS_DETAIL_PANE_CLASS,
  SettingsMasterDetail,
} from "@/components/settings/common/settings-master-detail"
import { AgentTeamTemplatesSection } from "@/components/settings/agent/agent-team-templates-section"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { useCreateSquad } from "@/hooks/squads/use-create-squad"
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
import { AutoComposeDialog } from "@/components/agent/workspace/auto-compose-dialog"
import { useProjectStore } from "@/stores/project/project-store"
import { useSquadDefinitionsHydrating } from "@/hooks/squads/use-squad-definitions-hydrating"

function SquadsSectionInner() {
  const t = useTranslations("settings.squads")
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const teams = useAgentTeamStore((s) => s.teams)
  const teammates = useAgentTeamStore((s) => s.teammates)
  const workspaceId = useProjectStore((state) => state.activeProjectId)

  const squads = useMemo(
    () =>
      Object.values(teams)
        // Workspace-scoped, like the assignee picker and the fleet console.
        // A Squad with no project is shared, not foreign.
        .filter((team) => !workspaceId || !team.projectId || team.projectId === workspaceId)
        .map((team) => ({
          id: team.id,
          name: team.name,
          memberCount: Object.values(teammates).filter((m) => m.teamId === team.id).length,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [teams, teammates, workspaceId]
  )

  const hydrating = useSquadDefinitionsHydrating()

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
    },
    [router, pathname, searchParams]
  )

  // Auto-compose: describe the objective, let the model staff the Squad. The
  // dialog was only ever reachable from a tab of `/agent-teams/workspace`, so
  // ADR-0140 took the door away without moving it anywhere. The library is
  // where a Squad comes into existence, so it belongs beside "New Squad".
  const [autoComposeOpen, setAutoComposeOpen] = useState(false)

  // Through `useCreateSquad`, shared with the fleet console, so a new Squad
  // starts on durable-v2 where the workspace supports it and both surfaces
  // resolve that default the same way. The resolver is async, which is why it
  // cannot live in the store's synchronous `createTeam`.
  const createSquad = useCreateSquad()
  const handleCreate = useCallback(() => {
    void createSquad({
      name: t("nav.newSquadName"),
      leadName: t("nav.defaultLeadName"),
    }).then((squad) => navigate(squadPanelId(squad.id)))
  }, [createSquad, navigate, t])

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
      loading={hydrating}
      squads={squads}
      activePanel={activePanel}
      onSelect={navigate}
      onCreate={handleCreate}
      onAutoCompose={() => setAutoComposeOpen(true)}
    />
  )

  return (
    <SettingsMasterDetail
      nav={() => nav}
      navTitle={t("nav.listTitle")}
      mobileTriggerLabel={t("nav.openList")}
      activeKey={activePanel}
      navWidth={300}
      triggerTestId="squads-nav-sheet-trigger"
      data-testid="squads-section"
    >
      <div className={SETTINGS_DETAIL_PANE_CLASS}>
        {/* Outside PanelTransition on purpose — see the file header. The pane
            header keeps naming the open Squad; the frame's own trigger row —
            which only appears once the pane is too narrow for any rail — is
            what opens the list there, so this header no longer carries a
            second copy of that button. */}
        <div className="flex shrink-0 items-center gap-2 border-b p-3">
          {hydrating ? null : (
            <span className="min-w-0 truncate text-sm font-medium">{headerTitle}</span>
          )}
          {!hydrating && activeSquad ? (
            <>
              <StatusBadge
                value={activeSquad.status}
                labelNamespace="agentTeam.status"
                className="shrink-0 text-[10px]"
                pulse={activeSquad.status === "executing" || activeSquad.status === "planning"}
              />
              {/* The way back to what this Squad is doing. Settings is where
                  it is configured, `/squads` is where it runs, and the second
                  only ever linked to the first. */}
              <Button
                asChild
                variant="ghost"
                size="sm"
                className="ml-auto h-7 shrink-0 gap-1 px-2 text-xs text-muted-foreground"
              >
                <Link
                  href={`/squads?id=${encodeURIComponent(activeSquad.id)}`}
                  data-testid="squad-detail-open-live"
                >
                  {t("detail.openLive")}
                  <ArrowUpRightIcon aria-hidden className="size-3.5" />
                </Link>
              </Button>
            </>
          ) : null}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {/* Nothing until the definitions land: no gallery standing in for a
              Squad that is about to arrive. */}
          {hydrating ? null : (
            <PanelTransition activeKey={activePanel}>
              {parsed.kind === "squad" ? (
                <SquadDetailPanel
                  squadId={parsed.id}
                  onOpenSquad={(id) => navigate(squadPanelId(id))}
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
          )}
        </div>
      </div>

      <AutoComposeDialog
        open={autoComposeOpen}
        onOpenChange={setAutoComposeOpen}
        onComposed={(teamId) => {
          setAutoComposeOpen(false)
          navigate(squadPanelId(teamId))
        }}
      />
    </SettingsMasterDetail>
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
