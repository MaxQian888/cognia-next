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
import { FileStackIcon, PlugIcon, SparklesIcon, type LucideIcon } from "lucide-react"

import { ConsoleSection } from "@/components/surface/console-section"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useClientLiveQuery } from "@/hooks/data"
import { listMcpServers } from "@/lib/db/mcp-servers"
import { listSkills } from "@/lib/db/skills"
import { listTemplateOwners } from "@/lib/db/template-platform"
import { useTemplateCatalog } from "@/hooks/use-template-catalog"
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
  /**
   * Only SHARED templates are listed. One confined to a workspace
   * (`TemplateDefinitionRow.workspaceId`) is simply absent elsewhere, so
   * offering a visibility toggle for it here would imply the other workspaces
   * could see it, which they cannot.
   */
  const { definitions: templateDefinitions } = useTemplateCatalog({})
  const templateOwners = useClientLiveQuery(() => listTemplateOwners(), [], {})

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

  const templateRows = useMemo<CapabilityRow[]>(
    () =>
      templateDefinitions
        .filter((definition) => templateOwners?.[definition.id] === undefined)
        .map((definition) => ({
          id: definition.id,
          name: definition.metadata.name,
          description: definition.domain,
          // A template has no global on/off flag of its own: being in the
          // catalog IS being available. So "inherit" means shown.
          globallyEnabled: true,
        })),
    [templateDefinitions, templateOwners]
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
      known.template = templateRows.map((row) => row.id)
      const pruned = pruneCapabilityOverlay(overlay, known)
      updateProject(workspaceId, {
        capabilityOverlay: withCapabilityState(pruned, kind, id, state),
      })
    },
    [overlay, servers, serverRows, skills, skillRows, templateRows, updateProject, workspaceId]
  )

  const overrideCount = countCapabilityOverrides(overlay)

  return (
    /*
      The pane container is declared here rather than by the tab: the cards
      below size off `@container/workspace-pane`, and a container query with no
      matching ancestor never fires. The sections are the console cards the
      sibling tabs use, not a hand-built uppercase heading over bare sections.
    */
    <div
      className="@container/workspace-pane flex flex-col gap-3.5"
      data-testid="workspace-capabilities"
    >
      <header className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <h2 className="text-[13px] font-semibold leading-tight">{t("title")}</h2>
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

      {/*
        `undefined` from a live query is "not read yet". Each card waits on its
        own source, so a slow template read does not hold back the skills.
      */}
      <CapabilitySection
        id="capabilities-skills"
        kind="skill"
        icon={SparklesIcon}
        title={t("skills")}
        empty={t("noSkills")}
        loading={skills === undefined}
        rows={skillRows}
        overlay={overlay}
        disabled={!workspaceId}
        onSet={setState}
      />

      <CapabilitySection
        id="capabilities-mcp-servers"
        kind="mcpServer"
        icon={PlugIcon}
        title={t("mcpServers")}
        empty={t("noMcpServers")}
        loading={servers === undefined}
        rows={serverRows}
        overlay={overlay}
        disabled={!workspaceId}
        onSet={setState}
      />

      <CapabilitySection
        id="capabilities-templates"
        kind="template"
        icon={FileStackIcon}
        title={t("templates")}
        empty={t("noTemplates")}
        // Until the owners are read every template looks shared, including
        // the ones confined to another workspace.
        loading={templateOwners === undefined}
        rows={templateRows}
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
  id,
  kind,
  icon,
  title,
  empty,
  loading,
  rows,
  overlay,
  disabled,
  onSet,
}: {
  id: string
  kind: WorkspaceCapabilityKind
  icon: LucideIcon
  title: string
  empty: string
  loading: boolean
  rows: CapabilityRow[]
  overlay: WorkspaceCapabilityOverlay | undefined
  disabled: boolean
  onSet: (kind: WorkspaceCapabilityKind, id: string, state: WorkspaceCapabilityState) => void
}) {
  const t = useTranslations("workspace.capabilities")

  return (
    <ConsoleSection
      id={id}
      pane="workspace-pane"
      idPrefix="workspace-section"
      icon={icon}
      title={title}
      meta={loading ? null : rows.length}
    >
      {loading ? (
        <div
          role="status"
          aria-busy="true"
          aria-label={t("loading")}
          className="flex flex-col gap-1"
          data-testid={`workspace-${kind}-loading`}
        >
          {[0, 1].map((index) => (
            <Skeleton key={index} className="h-12 w-full rounded-control" />
          ))}
        </div>
      ) : rows.length === 0 ? (
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
                className="flex items-center gap-3 rounded-control border px-3 py-2"
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
    </ConsoleSection>
  )
}
