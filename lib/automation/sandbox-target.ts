/**
 * Computer-Use execution target resolution (ADR-0020 remote-target addendum).
 *
 * A target is either the local host (existing Rust UIA/enigo backend) or a
 * remote cua sandbox referenced by `connectionId`. The setting form is stored
 * on `Character` and `ChatSession`; `undefined` means "inherit". Storing a
 * `connectionId` (never a bare "remote" flag) is the convergence anchor that
 * keeps a future ADR-0028 `cua-desktop` tier a pure addition.
 */

/** Stored shape on Character / ChatSession. `undefined` = inherit. */
export type ComputerUseTargetSetting = "local" | { connectionId: string } | undefined

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
