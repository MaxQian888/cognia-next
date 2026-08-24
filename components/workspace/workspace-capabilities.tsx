"use client"

/**
 * `/workspace` → Capabilities: which globally-defined skills and MCP servers
 * are live in THIS workspace.
 *
 * The definitions themselves are still managed where they always were —
 * Settings → Skills and Settings → MCP. This surface only records deltas, so it
 * shows each row's global state and lets the workspace say "not here" (or "yes,
 * here") on top of it. Anything left on Inherit follows the library, including
 * later changes to it; that is the difference between an overlay and a copy.
 *
 * Every row states its effective answer in words rather than leaving the user
 * to compose "globally on" with "workspace off" — the composition is the whole
 * feature, and a control that shows only its own half is how a surface starts
 * lying about what the agent will actually load.
 */

import { useCallback, useMemo } from "react"
import { useTranslations } from "next-intl"
import { PlugIcon, SparklesIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useClientLiveQuery } from "@/hooks/data"
import { listMcpServers } from "@/lib/db/mcp-servers"
import { listSkills } from "@/lib/db/skills"
import {
  capabilityStateOf,
  countCapabilityOverrides,
  pruneCapabilityOverlay,
  resolveCapabilityEnabled,
  withCapabilityState,
  type WorkspaceCapabilityKind,
  type WorkspaceCapabilityOverlay,
  type WorkspaceCapabilityState,
} from "@/lib/workspace/capability-overlay"
import { useProjectStore } from "@/stores/project/project-store"

const STATES: WorkspaceCapabilityState[] = ["inherit", "on", "off"]

interface CapabilityRow {
  id: string
  name: string
  description?: string
  globallyEnabled: boolean
  /**
   * The row cannot be loaded at all, whatever the workspace says — an MCP
   * server that has not been trusted. Kept separate from `globallyEnabled`
   * because an override CAN flip that one, and folding the two together made
   * this surface answer "Loaded here" for a server the resolver refuses to
   * hand over.
   */
  unavailable?: boolean
}

export interface WorkspaceCapabilitiesProps {
  /** The workspace being configured. Absent while the store is still hydrating. */
  workspaceId?: string | null
}

export function WorkspaceCapabilities({ workspaceId }: WorkspaceCapabilitiesProps) {
  const t = useTranslations("workspace.capabilities")
  const overlay = useProjectStore((s) => {
    const project = s.projects.find((candidate) => candidate.id === workspaceId)
    return project?.capabilityOverlay as WorkspaceCapabilityOverlay | undefined
  })
  const updateProject = useProjectStore((s) => s.updateProject)

  const skills = useClientLiveQuery(() => listSkills(), [], [])
  const servers = useClientLiveQuery(() => listMcpServers(), [], [])

  const skillRows = useMemo<CapabilityRow[]>(
    () =>
      (skills ?? []).map((skill) => ({
        id: skill.id,
        name: skill.name,
        description: skill.description ?? undefined,
        globallyEnabled: (skill.status ?? "enabled") === "enabled",
      })),
    [skills]
  )
  const serverRows = useMemo<CapabilityRow[]>(
    () =>
      (servers ?? []).map((server) => ({
        id: server.id,
        name: server.displayName || server.name,
        description: server.transport,
        globallyEnabled: server.enabled === true,
        // The trust gate is not the overlay's to open: `listEnabledMcpServers`
        // drops an unreviewed server before the overlay is consulted, so an
        // "on" override here would change nothing and must not claim to.
        unavailable: Boolean(
          server.trust && server.trust.state !== "legacy" && server.trust.state !== "trusted"
        ),
      })),
    [servers]
  )

  const setState = useCallback(
    (kind: WorkspaceCapabilityKind, id: string, state: WorkspaceCapabilityState) => {
      if (!workspaceId) return
      // Prune while writing rather than on load: a deleted skill's override
      // would otherwise keep inflating the "N overridden" badge for a row that
      // can no longer be shown or cleared. Only the kinds actually loaded are
      // pruned — see `pruneCapabilityOverlay`.
      const known: Partial<Record<WorkspaceCapabilityKind, string[]>> = {}
      if (skills) known.skill = skillRows.map((row) => row.id)
      if (servers) known.mcpServer = serverRows.map((row) => row.id)
      const pruned = pruneCapabilityOverlay(overlay, known)
      updateProject(workspaceId, {
        capabilityOverlay: withCapabilityState(pruned, kind, id, state),
      })
    },
    [overlay, servers, serverRows, skills, skillRows, updateProject, workspaceId]
  )

  const overrideCount = countCapabilityOverrides(overlay)

  return (
    <div className="flex flex-col gap-6" data-testid="workspace-capabilities">
      <header className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t("title")}
          </h2>
          {overrideCount > 0 ? (
            <Badge
              variant="secondary"
              className="font-normal"
              data-testid="workspace-override-count"
            >
              {t("overrideCount", { count: overrideCount })}
            </Badge>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </header>

      <CapabilitySection
        kind="skill"
        icon={<SparklesIcon aria-hidden className="size-3.5" />}
        title={t("skills")}
        empty={t("noSkills")}
        rows={skillRows}
        overlay={overlay}
        disabled={!workspaceId}
        onSet={setState}
      />

      <CapabilitySection
        kind="mcpServer"
        icon={<PlugIcon aria-hidden className="size-3.5" />}
        title={t("mcpServers")}
        empty={t("noMcpServers")}
        rows={serverRows}
        overlay={overlay}
        disabled={!workspaceId}
        onSet={setState}
      />

      {/*
        Deliberately a statement, not a disabled control. `plugins.enabled` is
        the runtime's loaded state rather than a preference, so there is nothing
        here to switch — and a greyed-out row would read as "coming soon" when
        the honest answer is "this one is machine-wide on purpose".
      */}
      <p
        className="text-xs text-muted-foreground"
        data-testid="workspace-capabilities-plugins-note"
      >
        {t("pluginsAreGlobal")}
      </p>
    </div>
  )
}

function CapabilitySection({
  kind,
  icon,
  title,
  empty,
  rows,
  overlay,
  disabled,
  onSet,
}: {
  kind: WorkspaceCapabilityKind
  icon: React.ReactNode
  title: string
  empty: string
  rows: CapabilityRow[]
  overlay: WorkspaceCapabilityOverlay | undefined
  disabled: boolean
  onSet: (kind: WorkspaceCapabilityKind, id: string, state: WorkspaceCapabilityState) => void
}) {
  const t = useTranslations("workspace.capabilities")

  return (
    <section className="flex flex-col gap-2">
      <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {icon}
        {title}
      </h3>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid={`workspace-${kind}-empty`}>
          {empty}
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {rows.map((row) => {
            const state = capabilityStateOf(overlay, kind, row.id)
            const live =
              !row.unavailable &&
              resolveCapabilityEnabled(row.globallyEnabled, overlay, kind, row.id)
            return (
              <li
                key={row.id}
                className="flex items-center gap-3 rounded-lg border px-3 py-2"
                data-testid={`workspace-capability-${kind}-${row.id}`}
              >
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm">{row.name}</span>
                  <span className="truncate text-[11px] text-muted-foreground">
                    {live ? t("effectiveOn") : t("effectiveOff")}
                    {row.unavailable
                      ? ` · ${t("unavailable")}`
                      : state === "inherit"
                        ? ` · ${row.globallyEnabled ? t("globallyOn") : t("globallyOff")}`
                        : ""}
                  </span>
                </div>
                <ToggleGroup
                  type="single"
                  size="sm"
                  value={state}
                  disabled={disabled || row.unavailable}
                  aria-label={t("stateLabel", { name: row.name })}
                  onValueChange={(value) => {
                    // Radix clears the value when the active item is clicked
                    // again; keeping the current state is the honest response to
                    // "no change requested".
                    if (value) onSet(kind, row.id, value as WorkspaceCapabilityState)
                  }}
                  className="text-xs"
                >
                  {STATES.map((candidate) => (
                    <ToggleGroupItem
                      key={candidate}
                      value={candidate}
                      data-testid={`workspace-capability-${kind}-${row.id}-${candidate}`}
                    >
                      {t(`state.${candidate}`)}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
