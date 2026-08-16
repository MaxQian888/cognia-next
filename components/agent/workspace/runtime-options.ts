import type { TeammateRuntime } from "@/types/agent/agent-team"
import { BUILTIN_EXECUTABLE_PRESET_IDS } from "@/lib/ai/agent/external/presets"

/**
 * Shared teammate-runtime dropdown options + label keys, used by both the
 * inline members picker (`members.tsx`) and the teammate config dialog
 * (`teammate-config-dialog.tsx`) so the two surfaces can never drift.
 *
 * `claude` (the Anthropic sidecar) plus every executable external preset,
 * derived from `BUILTIN_EXECUTABLE_PRESET_IDS` so the list stays in lock-step
 * with the preset catalog — `resolveTeammatePresetId` maps the runtime string
 * straight to a preset id.
 */
export const RUNTIME_OPTIONS: TeammateRuntime[] = ["claude", ...BUILTIN_EXECUTABLE_PRESET_IDS]

/**
 * i18n key (under `agentTeamsWorkspace.chat.runtime.*`) for each runtime. Typed
 * as an exhaustive Record so a new preset id fails the build until it is
 * labelled here and in the message bundles.
 */
export const RUNTIME_LABEL_KEYS: Record<TeammateRuntime, string> = {
  claude: "claude",
  codex: "codex",
  "codex-app-server": "codexAppServer",
  "claude-code": "claudeCode",
  "gemini-cli": "geminiCli",
  "cursor-cli": "cursorCli",
  "copilot-cli": "copilotCli",
  kiro: "kiro",
  "qwen-code": "qwenCode",
  pi: "pi",
  "pi-rpc": "piRpc",
  droid: "droid",
  "opencode-server": "opencodeServer",
  "opencode-remote": "opencodeRemote",
}

export function runtimeLabelKey(runtime: TeammateRuntime): string {
  return RUNTIME_LABEL_KEYS[runtime]
}
