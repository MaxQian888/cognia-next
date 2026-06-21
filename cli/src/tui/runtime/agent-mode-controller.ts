/**
 * `/agent-mode` controller — enumerate the selectable agent modes (built-ins +
 * `.cognia/modes/*.json` custom modes) and open the picker. Selecting a row
 * re-dispatches `/agent-mode <id>`, which the command turns into an `agentMode`
 * effect the App persists + live-applies. Disk discovery is injectable for tests.
 */
import { discoverCustomAgentModes, listAgentModes } from "../../config/agent-mode"
import type { AgentModeConfig } from "@/types/agent/agent-mode"
import type { SelectItem, TuiAction } from "../state/types"

export interface AgentModeDeps {
  dispatch: (action: TuiAction) => void
  cwd: string
  /** Discovery roots (project + home). Defaults to `[cwd]`. */
  roots?: string[]
  /** The active mode id (config.agentMode) — drives the "current" hint. */
  activeModeId?: string
  /** Inject discovered custom modes (tests); defaults to disk discovery. */
  listCustom?: () => Promise<AgentModeConfig[]>
}

/** Open the agent-mode picker, listing built-ins + discovered custom modes. */
export async function agentModeList(deps: AgentModeDeps): Promise<void> {
  const custom = deps.listCustom
    ? await deps.listCustom()
    : await discoverCustomAgentModes(deps.roots ?? [deps.cwd])
  const active = deps.activeModeId
  // "general" is the no-op built-in (no prompt/tools/permission), so it doubles
  // as the "(none)" / plain-chat choice and is surfaced once, at the top.
  const items: SelectItem[] = [
    {
      id: "general",
      label: "(none) — plain chat",
      hint: !active || active === "general" ? "current" : undefined,
    },
    ...listAgentModes(custom)
      .filter((m) => m.id !== "general")
      .map((m) => ({
        id: m.id,
        label: m.permissionMode ? `${m.name} [${m.permissionMode}]` : m.name,
        hint: m.id === active ? "current" : m.type === "custom" ? "custom" : undefined,
      })),
  ]
  deps.dispatch({
    type: "OVERLAY_OPEN",
    overlay: {
      kind: "select",
      title: "Agent mode",
      items,
      index: 0,
      onSelectCommand: "agent-mode",
    },
  })
}
