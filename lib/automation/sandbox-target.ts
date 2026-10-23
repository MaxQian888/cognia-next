import type { ComputerUseTargetSetting } from "@cognia/plugin-contract/lib/automation/sandbox-target"
export type { ComputerUseTargetSetting } from "@cognia/plugin-contract/lib/automation/sandbox-target"

/** Resolved, runtime form. */
export type ComputerUseTarget = { kind: "local" } | { kind: "remote"; connectionId: string }

function normalize(setting: ComputerUseTargetSetting): ComputerUseTarget | undefined {
  if (setting === undefined) return undefined
  if (setting === "local") return { kind: "local" }
  return { kind: "remote", connectionId: setting.connectionId }
}

/** Precedence: session → character → local. `undefined` means "inherit". */
export function resolveComputerUseTarget(
  session: ComputerUseTargetSetting,
  character: ComputerUseTargetSetting
): ComputerUseTarget {
  return normalize(session) ?? normalize(character) ?? { kind: "local" }
}
