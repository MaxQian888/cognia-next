/**
 * Every modal overlay the TUI can show, switched on `state.overlay.kind`. Lifted
 * out of {@link App} (which still owns all the state + handlers) so the root
 * render tree reads as a handful of regions instead of a 600-line wall of
 * `state.overlay.kind === "…"` branches. The handlers are threaded in verbatim so
 * the behaviour is byte-for-byte the same as when it lived in App.
 */
import React from "react"
import fs from "node:fs"
import os from "node:os"
import { spawn } from "node:child_process"
import type { Dispatch } from "react"

import { SelectList } from "../SelectList"
import { MarketplaceBrowser } from "../MarketplaceBrowser"
import { McpPanel } from "../McpPanel"
import { McpToolsPanel } from "../McpToolsPanel"
import { SkillPanel } from "../SkillPanel"
import { EffortSlider } from "../EffortSlider"
import { PermissionOverlay } from "../overlays/PermissionOverlay"
import { Help } from "../overlays/Help"
import { HistorySearch } from "../overlays/HistorySearch"
import { UsagePanel } from "../overlays/UsagePanel"
import { LimitsPanel } from "../overlays/LimitsPanel"
import { StatusPanel } from "../overlays/StatusPanel"
import { DoctorPanel } from "../overlays/DoctorPanel"
import { DocumentViewer } from "../overlays/DocumentViewer"
import { InspectOverlay } from "../overlays/InspectOverlay"
import { AgentsPanel } from "../overlays/AgentsPanel"
import { AgentRunPage } from "../overlays/AgentRunPage"
import { SubagentModelsPanel } from "../overlays/SubagentModelsPanel"
import { ConfirmOverlay } from "../overlays/ConfirmOverlay"
import { PlanApprovalOverlay } from "../overlays/PlanApprovalOverlay"
import { AskUserDialog } from "../overlays/AskUserDialog"
import { FormOverlay } from "../overlays/FormOverlay"
import { SettingsOverlay } from "../overlays/SettingsOverlay"
import { cycleSubagentModel, cycleSubagentProvider } from "../../runtime/subagent-models-model"
import { catalogModelIds } from "@/lib/ai/model-options"
import { formatModelOptionLabel, modelInfoHint } from "../model-options"
import { filterByQuery } from "../select-list-state"
import {
  SEARCHABLE_MIN,
  filterInspectItems,
  filterQuickActions,
  filterSelectItems,
  filterSessionItems,
} from "../../state/overlay-search"
import { collectProviderOptions } from "../../commands/provider-options"
import {
  readCrashReportText,
  resolveCrashLogDirs,
  type CrashLogFs,
} from "../../runtime/crash-log-discovery"
import {
  mcpPanel as runMcpPanel,
  mcpReconnect,
  mcpToggleServerInPanel,
  mcpToggleTool,
  openMcpToolsPanel,
  type McpDeps,
} from "../../runtime/mcp-controller"
import {
  setEnabled as setSkillEnabled,
  setManyEnabled as setManySkillsEnabled,
} from "../../../skill/skill-state"
import { getLiveSubagent, listLiveSubagents } from "../../../agent/subagent-live-output"
import { listCliBackgroundRuns } from "../../../agent/subagent-background-tasks"
import { refreshAgentPanelRows } from "../../runtime/agents-panel-model"
import { formatToolResultBody } from "../../commands/expand-command"
import { cycleEnum, applyTargetDefault } from "../../runtime/settings-sections"
import { EFFORT_SLIDER_LEVELS, PERMISSION_MODES } from "../../../config/schema"
import { deriveEffortSliderState, modelSupportsEffort } from "../../../config/thinking"
import { bufferFromText } from "../../input/buffer"
import type { CapturePermissionDecision } from "@/lib/claude/run-and-capture"
import type { ThinkingLevel, SubagentModelOverride } from "../../../config/schema"
import type { ConfigMenuRow } from "../../commands/config-menu"
import type { TuiState, TuiAction } from "../../state/types"
import { permissionModeMeta, permissionRiskMarker } from "../../state/permission-mode-meta"
import type { AgentSessionApi } from "../../hooks/useAgentSession"
import type { AskUserOverlayApi } from "../../hooks/use-ask-user-overlay"
import type { PlanDecision } from "../../runtime/plan"
import type { SettingsRow, SettingsApplyTarget } from "../../runtime/settings-sections"

export interface AppOverlaysProps {
  state: TuiState
  dispatch: Dispatch<TuiAction>
  agent: AgentSessionApi
  columns: number
  overlayRows: number
  activeModel: string | undefined
  home: string
  resolvePermission: (decision: CapturePermissionDecision) => void
  persist: (key: string, value: string) => boolean
  persistProviderModelFn: (providerId: string, modelId: string) => boolean
  persistPluginTools: (home: string, enabled: boolean) => void
  openModelPicker: () => void
  applySettings: (target: SettingsApplyTarget, value: string | boolean) => void
  activateSettings: (row: SettingsRow) => void
  applySubagentModelEdit: (agentId: string, override: SubagentModelOverride | null) => void
  applyHistorySearch: (query: string, fromIndex: number) => void
  doResume: (id: string) => void
  runCommandLine: (line: string) => void
  submitForm: () => void
  onPlanDecision: (decision: PlanDecision) => void
  askUser: AskUserOverlayApi
  mcpPanelDeps: () => McpDeps
}

export function AppOverlays(props: AppOverlaysProps): React.ReactElement {
  const {
    state,
    dispatch,
    agent,
    columns,
    overlayRows,
    activeModel,
    home,
    resolvePermission,
    persist,
    persistProviderModelFn,
    persistPluginTools,
    openModelPicker,
    applySettings,
    activateSettings,
    applySubagentModelEdit,
    applyHistorySearch,
    doResume,
    runCommandLine,
    submitForm,
    onPlanDecision,
    askUser,
    mcpPanelDeps,
  } = props

  // Live refresher for the open agents panel: re-merge the live-output store +
  // background registry over the journal-backed snapshot the panel opened with,
  // so statuses/tokens/tool counts move while it is on screen. Unconditional
  // hook (overlay kind varies render-to-render); a no-op unless the panel is up.
  const agentsOverlayRows = state.overlay.kind === "agents" ? state.overlay.rows : null
  const sessionId = state.sessionId
  const refreshAgents = React.useCallback(
    () =>
      refreshAgentPanelRows(
        agentsOverlayRows ?? [],
        listLiveSubagents(sessionId),
        listCliBackgroundRuns(sessionId)
      ),
    [agentsOverlayRows, sessionId]
  )

  return (
    <>
      {state.overlay.kind === "permission" && (
        <PermissionOverlay
          req={state.overlay.req}
          choices={state.overlay.choices}
          index={state.overlay.index}
          onMove={(delta) => dispatch({ type: "OVERLAY_MOVE", delta })}
          onResolve={resolvePermission}
        />
      )}
      {state.overlay.kind === "model" &&
        (() => {
          // The list can run to hundreds of OpenRouter ids, so the picker
          // filters by a typeahead query. `index` already tracks the FILTERED
          // view (reducer), so map the selected row back through `filtered`.
          const filtered = filterByQuery(state.overlay.options, state.overlay.query)
          return (
            <SelectList
              title="Switch model"
              items={filtered.map((m) => ({
                label: formatModelOptionLabel(m, state.config.provider),
                hint: modelInfoHint(m, state.config.provider),
              }))}
              index={state.overlay.index}
              width={columns}
              maxRows={overlayRows}
              query={state.overlay.query}
              searchPlaceholder="type to filter models"
              emptyHint="no models match"
              onQueryChange={(q) => dispatch({ type: "OVERLAY_MODEL_QUERY", query: q })}
              onMove={(delta) => dispatch({ type: "OVERLAY_MOVE", delta })}
              onSelect={(i) => {
                const m = filtered[i]
                if (!m) return
                // Remember the pick under the ACTIVE provider, not as a global pin —
                // so it survives a provider switch and never bleeds onto others.
                persistProviderModelFn(state.config.provider, m)
                void agent.switchModel(m)
              }}
              onCancel={() => dispatch({ type: "OVERLAY_CLOSE" })}
            />
          )
        })()}
      {state.overlay.kind === "mode" && (
        <SelectList
          title="Permission mode — Shift+Tab cycles the safe core; ⚠/• = fewer guardrails"
          items={state.overlay.options.map((m) => {
            const meta = permissionModeMeta(m)
            return {
              label: `${permissionRiskMarker(m)}${meta.label}`,
              hint: meta.runsWithoutAsking,
            }
          })}
          index={state.overlay.index}
          width={columns}
          maxRows={overlayRows}
          onMove={(delta) => dispatch({ type: "OVERLAY_MOVE", delta })}
          onSelect={(i) => {
            const m = (state.overlay as { options: (typeof PERMISSION_MODES)[number][] }).options[i]
            persist("permissionMode", m)
            void agent.switchMode(m)
          }}
          onCancel={() => dispatch({ type: "OVERLAY_CLOSE" })}
        />
      )}
      {state.overlay.kind === "effortSlider" && (
        <EffortSlider
          off={state.overlay.off}
          index={state.overlay.index}
          width={columns}
          supported={modelSupportsEffort(state.config.provider, activeModel)}
          modelLabel={activeModel}
          onConfirm={({ off, index }) => {
            // Resolve the picked level: off → "off", else the slider tier.
            const lvl: ThinkingLevel = off ? "off" : EFFORT_SLIDER_LEVELS[index]
            // `ultracode` couples to the dynamic-workflow plugin tools; every
            // other tier turns the gate back off (per the slider's contract).
            const pluginTools = lvl === "ultracode"
            persist("thinkingLevel", lvl)
            persistPluginTools(home, pluginTools)
            // switchThinking dispatches SET_THINKING (with pluginTools) AND
            // drops the session so the new effort + gate apply next turn.
            void agent.switchThinking(lvl, pluginTools)
            // Warn (but still save) when the active model won't honour effort —
            // the preference re-applies once a reasoning-capable model is active.
            if (lvl !== "off" && !modelSupportsEffort(state.config.provider, activeModel)) {
              dispatch({
                type: "NOTICE",
                message: `Saved. Note: ${activeModel ?? "the current model"} doesn't support thinking levels — it applies when you switch to a reasoning model (Opus 4.5+, Sonnet 4.6, o-series, …).`,
              })
            }
          }}
          onCancel={() => dispatch({ type: "OVERLAY_CLOSE" })}
        />
      )}
      {state.overlay.kind === "provider" && (
        <SelectList
          title="Switch provider"
          items={state.overlay.options.map((p) => ({
            label: p.name,
            hint: `${p.id} · ${p.configured ? p.auth : "not configured"}`,
          }))}
          index={state.overlay.index}
          width={columns}
          maxRows={overlayRows}
          onMove={(delta) => dispatch({ type: "OVERLAY_MOVE", delta })}
          onSelect={(i) => {
            const picked = (state.overlay as { options: { id: string; configured: boolean }[] })
              .options[i]
            // Reset to the new provider's default model so the active model is
            // always valid for the provider: the provider's own configured model
            // wins, else its curated catalog default (shared model catalog).
            const defaultModel =
              state.config.providers[picked.id]?.model ?? catalogModelIds(picked.id)[0]
            persist("provider", picked.id)
            // Do NOT pin a top-level model on switch — the provider's own
            // remembered model (or its catalog default) drives the display via
            // resolveActiveModel, so switching never strands another provider's id.
            void agent.switchProvider(picked.id, defaultModel)
            if (!picked.configured) {
              dispatch({
                type: "NOTICE",
                message: `No credential for "${picked.id}" — run: cognia-agent auth login --provider ${picked.id} --api-key <key>`,
              })
            }
          }}
          onCancel={() => dispatch({ type: "OVERLAY_CLOSE" })}
        />
      )}
      {state.overlay.kind === "config" && (
        <SelectList
          title="Settings"
          items={state.overlay.rows.map((r) => ({ label: r.label, hint: r.value }))}
          index={state.overlay.index}
          width={columns}
          maxRows={overlayRows}
          onMove={(delta) => dispatch({ type: "OVERLAY_MOVE", delta })}
          onSelect={(i) => {
            const row = (state.overlay as { rows: ConfigMenuRow[] }).rows[i]
            switch (row.action) {
              case "provider":
                dispatch({
                  type: "OVERLAY_OPEN",
                  overlay: {
                    kind: "provider",
                    options: collectProviderOptions(state.config),
                    index: 0,
                  },
                })
                break
              case "model": {
                openModelPicker()
                break
              }
              case "mode":
                dispatch({
                  type: "OVERLAY_OPEN",
                  overlay: { kind: "mode", options: [...PERMISSION_MODES], index: 0 },
                })
                break
              case "thinking":
                dispatch({
                  type: "OVERLAY_OPEN",
                  overlay: {
                    kind: "effortSlider",
                    ...deriveEffortSliderState(state.config.thinkingLevel),
                  },
                })
                break
              case "auth":
                dispatch({
                  type: "NOTICE",
                  message: `Auth: ${row.value}. Set with: cognia-agent auth login --provider ${state.config.provider} --api-key <key> | --subscription <token>`,
                })
                break
              case "cwd":
                dispatch({ type: "NOTICE", message: state.config.cwd })
                break
            }
          }}
          onCancel={() => dispatch({ type: "OVERLAY_CLOSE" })}
        />
      )}
      {state.overlay.kind === "settings" && (
        <SettingsOverlay
          sections={state.overlay.sections}
          section={state.overlay.section}
          index={state.overlay.index}
          width={columns}
          maxRows={overlayRows}
          onMoveRow={(delta) => dispatch({ type: "OVERLAY_MOVE", delta })}
          onSwitchSection={(delta) => {
            if (state.overlay.kind !== "settings") return
            const len = state.overlay.sections.length
            const next = (((state.overlay.section + delta) % len) + len) % len
            dispatch({
              type: "OVERLAY_OPEN",
              overlay: {
                kind: "settings",
                sections: state.overlay.sections,
                section: next,
                index: 0,
              },
            })
          }}
          onAdjust={(row, delta) => {
            if (row.control.type !== "enum") return
            applySettings(
              row.control.apply,
              cycleEnum(row.control.options, row.control.current, delta)
            )
          }}
          onToggle={(row) => {
            if (row.control.type !== "boolean") return
            applySettings(row.control.apply, !row.control.current)
          }}
          onReset={(row) => {
            // Reset the focused enum/boolean row to its product default by
            // feeding the default straight back through the same apply path.
            if (row.control.type !== "enum" && row.control.type !== "boolean") return
            const def = applyTargetDefault(row.control.apply)
            if (def === undefined) return
            applySettings(row.control.apply, def)
          }}
          onActivate={(row) => activateSettings(row)}
          onClose={() => dispatch({ type: "OVERLAY_CLOSE" })}
        />
      )}
      {state.overlay.kind === "sessions" &&
        (() => {
          const all = state.overlay.items
          const query = state.overlay.query ?? ""
          const filtered = filterSessionItems(all, query)
          const searchable = all.length >= SEARCHABLE_MIN
          return (
            <SelectList
              title="Resume session"
              items={filtered.map((s) => ({ label: s.title, hint: `${s.turns} turns` }))}
              index={state.overlay.index}
              width={columns}
              maxRows={overlayRows}
              query={searchable ? query : undefined}
              searchPlaceholder={searchable ? "type to filter sessions" : undefined}
              emptyHint={searchable ? "no sessions match" : undefined}
              onQueryChange={
                searchable ? (q) => dispatch({ type: "OVERLAY_QUERY", query: q }) : undefined
              }
              onMove={(delta) => dispatch({ type: "OVERLAY_MOVE", delta })}
              onSelect={(i) => {
                const picked = filtered[i]
                if (!picked) return
                dispatch({ type: "OVERLAY_CLOSE" })
                doResume(picked.sessionId)
              }}
              onCancel={() => dispatch({ type: "OVERLAY_CLOSE" })}
            />
          )
        })()}
      {state.overlay.kind === "select" &&
        (() => {
          const o = state.overlay
          const query = o.query ?? ""
          const filtered = filterSelectItems(o.items, query)
          const searchable = o.items.length >= SEARCHABLE_MIN
          return (
            <SelectList
              title={o.title}
              items={filtered.map((it) => ({ label: it.label, hint: it.hint }))}
              index={o.index}
              width={columns}
              maxRows={overlayRows}
              query={searchable ? query : undefined}
              searchPlaceholder={searchable ? "type to filter" : undefined}
              emptyHint={searchable ? "no matches" : undefined}
              onQueryChange={
                searchable ? (q) => dispatch({ type: "OVERLAY_QUERY", query: q }) : undefined
              }
              onMove={(delta) => dispatch({ type: "OVERLAY_MOVE", delta })}
              onSelect={(i) => {
                const item = filtered[i]
                dispatch({ type: "OVERLAY_CLOSE" })
                // View-only lists (no command) just close on Enter.
                if (item && o.onSelectCommand)
                  runCommandLine(`/${o.onSelectCommand} ${item.id}`.trim())
              }}
              onCancel={() => dispatch({ type: "OVERLAY_CLOSE" })}
            />
          )
        })()}
      {state.overlay.kind === "inspect" &&
        (() => {
          const all = state.overlay.items
          const query = state.overlay.query ?? ""
          const filtered = filterInspectItems(all, query)
          const searchable = all.length >= SEARCHABLE_MIN
          return (
            <InspectOverlay
              items={filtered}
              index={state.overlay.index}
              width={columns}
              maxRows={overlayRows}
              query={searchable ? query : undefined}
              onQueryChange={
                searchable ? (q) => dispatch({ type: "OVERLAY_QUERY", query: q }) : undefined
              }
              onMove={(delta) => dispatch({ type: "OVERLAY_MOVE", delta })}
              onSelect={(i) => {
                const item = filtered[i]
                const cell = item ? state.cells.find((c) => c.id === item.cellId) : undefined
                if (cell?.kind === "tool") {
                  dispatch({
                    type: "OVERLAY_OPEN",
                    overlay: {
                      kind: "document",
                      title: `${cell.toolName} output`,
                      body: formatToolResultBody(cell),
                      format: "markdown",
                    },
                  })
                } else if (cell?.kind === "bash") {
                  dispatch({
                    type: "OVERLAY_OPEN",
                    overlay: {
                      kind: "document",
                      title: "bash output",
                      body: "# bash\n\n```bash\n" + cell.output + "\n```",
                      format: "markdown",
                    },
                  })
                } else {
                  dispatch({ type: "OVERLAY_CLOSE" })
                }
              }}
              onCancel={() => dispatch({ type: "OVERLAY_CLOSE" })}
            />
          )
        })()}
      {state.overlay.kind === "marketplace" && (
        <MarketplaceBrowser
          entries={state.overlay.entries}
          width={columns}
          maxRows={overlayRows}
          onAction={(entry, action) => {
            // enable/disable keep the browser open: patch the badge for instant
            // feedback, then run the command (which persists + flips the live
            // manager but emits only a NOTICE, leaving this overlay mounted).
            if (action === "enable" || action === "disable") {
              if (!entry.installedId) return
              dispatch({
                type: "MARKETPLACE_PATCH_ENTRY",
                ref: entry.installRef,
                patch: { enabled: action === "enable" },
              })
              runCommandLine(`/plugin ${action} ${entry.installedId}`)
              return
            }
            // Heavier actions go through their own command path (consent overlay
            // for install; document/notice for the rest), so close first.
            dispatch({ type: "OVERLAY_CLOSE" })
            if (action === "install") runCommandLine(`/plugin install ${entry.installRef}`.trim())
            else if (action === "show" && entry.installedId)
              runCommandLine(`/plugin show ${entry.installedId}`)
            else if (action === "update" && entry.installedId)
              runCommandLine(`/plugin update ${entry.installedId}`)
            else if (action === "uninstall" && entry.installedId)
              runCommandLine(`/plugin uninstall ${entry.installedId}`)
          }}
          onCancel={() => dispatch({ type: "OVERLAY_CLOSE" })}
        />
      )}
      {state.overlay.kind === "mcp" && (
        <McpPanel
          servers={state.overlay.servers}
          probing={state.overlay.probing}
          width={columns}
          maxRows={overlayRows}
          onTools={(name) => void openMcpToolsPanel(name, mcpPanelDeps())}
          onAuth={(name) => {
            dispatch({ type: "OVERLAY_CLOSE" })
            runCommandLine(`/mcp auth ${name}`)
          }}
          onReconnect={(name) => void mcpReconnect(name, mcpPanelDeps())}
          onToggle={(name) =>
            void mcpToggleServerInPanel(name, mcpPanelDeps()).then(() => agent.invalidate())
          }
          onAdd={() => {
            dispatch({ type: "OVERLAY_CLOSE" })
            runCommandLine("/mcp add")
          }}
          onRemove={(name) =>
            dispatch({
              type: "OVERLAY_OPEN",
              overlay: {
                kind: "confirm",
                title: "Remove MCP server",
                body: `Remove **${name}** from \`~/.cognia/mcp.json\`?\n\nRe-add it any time with \`/mcp add\`.`,
                format: "markdown",
                onConfirmCommand: `mcp remove ${name}`,
                onCancelCommand: "mcp",
              },
            })
          }
          onCancel={() => dispatch({ type: "OVERLAY_CLOSE" })}
        />
      )}
      {state.overlay.kind === "mcpTools" && (
        <McpToolsPanel
          server={state.overlay.server}
          tools={state.overlay.tools}
          width={columns}
          maxRows={overlayRows}
          onToggle={(tool, enabled) => {
            if (state.overlay.kind !== "mcpTools") return
            mcpToggleTool(state.overlay.server, tool, enabled, mcpPanelDeps())
            agent.invalidate()
          }}
          onBack={() => void runMcpPanel(mcpPanelDeps())}
        />
      )}
      {state.overlay.kind === "skills" && (
        <SkillPanel
          rows={state.overlay.rows}
          width={columns}
          maxRows={overlayRows}
          loadMode={state.config.skillLoadMode ?? "name"}
          onToggleLoadMode={() => {
            const next = (state.config.skillLoadMode ?? "name") === "name" ? "full" : "name"
            applySettings({ kind: "configValue", key: "skillLoadMode" }, next)
          }}
          onToggle={(id) => {
            if (state.overlay.kind !== "skills") return
            const row = state.overlay.rows.find((r) => r.id === id)
            try {
              setSkillEnabled(home, id, !(row?.enabled ?? false))
            } catch {
              // read-only home: the badge still flips for this session.
            }
            dispatch({ type: "SKILL_ROW_TOGGLE", id })
            agent.invalidate()
          }}
          onSetAll={(ids, enabled) => {
            if (state.overlay.kind !== "skills") return
            try {
              setManySkillsEnabled(home, ids, enabled)
            } catch {
              // read-only home: the badges still flip for this session.
            }
            dispatch({ type: "SKILL_ROWS_SET_MANY", ids, enabled })
            agent.invalidate()
          }}
          onShow={(id) => {
            dispatch({ type: "OVERLAY_CLOSE" })
            runCommandLine(`/skill show ${id}`)
          }}
          onCreate={() => {
            dispatch({ type: "OVERLAY_CLOSE" })
            runCommandLine("/skill create")
          }}
          onDelete={(id) =>
            dispatch({
              type: "OVERLAY_OPEN",
              overlay: {
                kind: "confirm",
                title: "Delete skill",
                body: `Delete skill \`${id}\`?\n\nBuilt-in and on-disk skills are kept (delete their folder instead).`,
                format: "markdown",
                onConfirmCommand: `skill delete ${id}`,
                onCancelCommand: "skill",
              },
            })
          }
          onCancel={() => dispatch({ type: "OVERLAY_CLOSE" })}
        />
      )}
      {state.overlay.kind === "agents" && (
        <AgentsPanel
          rows={state.overlay.rows}
          refresh={refreshAgents}
          width={columns}
          maxRows={overlayRows}
          onView={(row) => {
            // A row backed by the live-output store opens the live run page —
            // watch its streamed text/thinking/tools (running OR recently
            // settled). Otherwise fall back to the settled-output pager.
            if (row.liveId && getLiveSubagent(row.liveId, state.sessionId)) {
              dispatch({
                type: "OVERLAY_OPEN",
                overlay: {
                  kind: "agentRun",
                  liveId: row.liveId,
                  name: row.name,
                  task: row.task,
                },
              })
            } else if (row.output) {
              dispatch({
                type: "OVERLAY_OPEN",
                overlay: {
                  kind: "document",
                  title: row.name,
                  body: row.output,
                  format: "text",
                },
              })
            } else {
              dispatch({ type: "OVERLAY_CLOSE" })
              dispatch({
                type: "NOTICE",
                message:
                  row.status === "running"
                    ? `"${row.name}" is still running — no output yet.`
                    : `No output recorded for "${row.name}".`,
              })
            }
          }}
          onCancel={() => dispatch({ type: "OVERLAY_CLOSE" })}
        />
      )}
      {state.overlay.kind === "quickActions" &&
        (() => {
          const query = state.overlay.query ?? ""
          const filtered = filterQuickActions(state.overlay.rows, query)
          return (
            <SelectList
              title="Command center"
              items={filtered.map((r) => ({ label: r.label, hint: r.hint }))}
              index={state.overlay.index}
              width={columns}
              maxRows={overlayRows}
              query={query}
              searchPlaceholder="type to filter commands"
              emptyHint="no commands match"
              footerHint="type to search · ↑/↓ navigate · Enter / click run · Esc close"
              onQueryChange={(q) => dispatch({ type: "OVERLAY_QUERY", query: q })}
              onMove={(delta) => dispatch({ type: "OVERLAY_MOVE", delta })}
              onSelect={(i) => {
                const row = filtered[i]
                // Close the command center first, then run the picked command —
                // most targets open their own overlay (which would replace this
                // one anyway), but a notice/runtime target must not leave the
                // menu hanging behind it.
                dispatch({ type: "OVERLAY_CLOSE" })
                if (row) runCommandLine(row.command)
              }}
              onCancel={() => dispatch({ type: "OVERLAY_CLOSE" })}
            />
          )
        })()}
      {state.overlay.kind === "agentRun" && (
        <AgentRunPage
          liveId={state.overlay.liveId}
          name={state.overlay.name}
          task={state.overlay.task}
          width={columns}
          getEntry={(id) => getLiveSubagent(id, state.sessionId)}
          onClose={() => dispatch({ type: "OVERLAY_CLOSE" })}
        />
      )}
      {state.overlay.kind === "subagentModels" && (
        <SubagentModelsPanel
          rows={state.overlay.rows}
          index={state.overlay.index}
          width={columns}
          maxRows={overlayRows}
          onMove={(delta) => dispatch({ type: "OVERLAY_MOVE", delta })}
          onCycleModel={(row, delta) =>
            applySubagentModelEdit(row.id, cycleSubagentModel(row, delta))
          }
          onCycleProvider={(row, delta) =>
            applySubagentModelEdit(row.id, cycleSubagentProvider(row, delta))
          }
          onReset={(row) => applySubagentModelEdit(row.id, null)}
          onClose={() => dispatch({ type: "OVERLAY_CLOSE" })}
        />
      )}
      {state.overlay.kind === "askUser" && (
        <AskUserDialog request={state.overlay.request} onResolve={askUser.resolve} />
      )}
      {state.overlay.kind === "form" && (
        <FormOverlay
          form={state.overlay.form}
          onUpdate={(f) => dispatch({ type: "FORM_UPDATE", form: f })}
          onSubmit={submitForm}
          onCancel={() => dispatch({ type: "OVERLAY_CLOSE" })}
        />
      )}
      {state.overlay.kind === "usage" && (
        <UsagePanel
          usage={state.usage}
          model={activeModel}
          totals={state.sessionTotals}
          contextWindow={state.modelMeta?.contextWindow}
          pricing={state.modelMeta?.pricing}
          usageHistory={state.usageHistory}
          costHistory={state.costHistory}
          toolStats={state.toolStats}
          modelTotals={state.modelTotals}
          onClose={() => dispatch({ type: "OVERLAY_CLOSE" })}
        />
      )}
      {state.overlay.kind === "limits" && (
        <LimitsPanel
          snapshots={state.overlay.snapshots}
          analysis={state.overlay.analysis}
          now={state.overlay.now}
          rateLimits={state.overlay.rateLimits}
          activeProvider={state.overlay.activeProvider}
          onClose={() => dispatch({ type: "OVERLAY_CLOSE" })}
        />
      )}
      {state.overlay.kind === "help" && (
        <Help onClose={() => dispatch({ type: "OVERLAY_CLOSE" })} />
      )}
      {state.overlay.kind === "historySearch" && (
        <HistorySearch
          query={state.overlay.query}
          match={state.overlay.match}
          onChar={(ch) => {
            const o = state.overlay as { query: string }
            // A fresh refinement restarts from the most-recent end of history.
            applyHistorySearch(o.query + ch, state.input.history.entries.length)
          }}
          onBackspace={() => {
            const o = state.overlay as { query: string }
            applyHistorySearch(o.query.slice(0, -1), state.input.history.entries.length)
          }}
          onNext={() => {
            const o = state.overlay as { query: string; matchIndex: number }
            // Cycle to the next-older match: pass the current hit's index.
            applyHistorySearch(o.query, o.matchIndex)
          }}
          onAccept={() => {
            const o = state.overlay as { match: string | null }
            dispatch({ type: "OVERLAY_CLOSE" })
            if (o.match) dispatch({ type: "INPUT_SET", buffer: bufferFromText(o.match) })
          }}
          onCancel={() => dispatch({ type: "OVERLAY_CLOSE" })}
        />
      )}
      {state.overlay.kind === "status" && (
        <StatusPanel
          report={state.overlay.report}
          onClose={() => dispatch({ type: "OVERLAY_CLOSE" })}
        />
      )}
      {state.overlay.kind === "doctor" && (
        <DoctorPanel
          report={state.overlay.report}
          onClose={() => dispatch({ type: "OVERLAY_CLOSE" })}
          onViewReport={(stem) => {
            const dirs = resolveCrashLogDirs(process.platform, process.env, os.homedir())
            if (!dirs.crashReportsDir) return
            const nodeFs: CrashLogFs = {
              readdirSync: (dir) => fs.readdirSync(dir, { withFileTypes: true }),
              readFileSync: (p, encoding) => fs.readFileSync(p, encoding),
              statSync: (p) => fs.statSync(p),
            }
            const body = readCrashReportText(dirs.crashReportsDir, stem, nodeFs)
            if (body == null) return
            dispatch({
              type: "OVERLAY_OPEN",
              overlay: {
                kind: "document",
                title: `Crash report · ${stem}`,
                body,
                format: "text",
              },
            })
          }}
          onOpenDir={() => {
            const dirs = resolveCrashLogDirs(process.platform, process.env, os.homedir())
            const dir = dirs.crashReportsDir
            if (!dir) return
            const platform = process.platform
            const cmd =
              platform === "win32" ? "explorer" : platform === "darwin" ? "open" : "xdg-open"
            const args = platform === "win32" ? [dir] : [dir]
            spawn(cmd, args, { stdio: "ignore", detached: true }).unref()
          }}
        />
      )}
      {state.overlay.kind === "document" && (
        <DocumentViewer
          title={state.overlay.title}
          body={state.overlay.body}
          format={state.overlay.format}
          lang={state.overlay.lang}
          onClose={() => dispatch({ type: "OVERLAY_CLOSE" })}
        />
      )}
      {state.overlay.kind === "plan" && (
        <PlanApprovalOverlay
          index={state.overlay.index}
          savedTo={state.overlay.savedTo}
          raw={state.overlay.raw}
          prevPlan={state.overlay.prevPlan}
          onMove={(delta) => dispatch({ type: "OVERLAY_MOVE", delta })}
          onSelect={onPlanDecision}
          onCancel={() => dispatch({ type: "OVERLAY_CLOSE" })}
        />
      )}
      {state.overlay.kind === "confirm" && (
        <ConfirmOverlay
          title={state.overlay.title}
          body={state.overlay.body}
          format={state.overlay.format}
          onConfirm={() => {
            const cmd = (state.overlay as { onConfirmCommand: string }).onConfirmCommand
            dispatch({ type: "OVERLAY_CLOSE" })
            runCommandLine(`/${cmd}`.trim())
          }}
          onCancel={() => {
            const cancel = (state.overlay as { onCancelCommand?: string }).onCancelCommand
            dispatch({ type: "OVERLAY_CLOSE" })
            if (cancel) runCommandLine(`/${cancel}`.trim())
          }}
        />
      )}
    </>
  )
}
