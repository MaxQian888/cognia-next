import type { Live2dParameterMapping, Live2dParameterRole } from "@/types/pet"

const STANDARD_PARAMETERS: Record<Live2dParameterRole, readonly string[]> = {
  headX: ["ParamAngleX", "PARAM_ANGLE_X"],
  headY: ["ParamAngleY", "PARAM_ANGLE_Y"],
  headZ: ["ParamAngleZ", "PARAM_ANGLE_Z"],
  eyeX: ["ParamEyeBallX", "PARAM_EYE_BALL_X"],
  eyeY: ["ParamEyeBallY", "PARAM_EYE_BALL_Y"],
  bodyX: ["ParamBodyAngleX", "PARAM_BODY_ANGLE_X"],
  bodyY: ["ParamBodyAngleY", "PARAM_BODY_ANGLE_Y"],
  mouthOpen: ["ParamMouthOpenY", "PARAM_MOUTH_OPEN_Y"],
}

/**
 * Canonical parameter id → role, derived from {@link STANDARD_PARAMETERS} so it
 * covers every spelling (`ParamAngleX` and `PARAM_ANGLE_X`) and cannot fall
 * behind when a role is added. Hand-maintaining the reverse direction is how a
 * parameter write ends up silently dropped for want of a role.
 */
const ROLE_BY_PARAMETER_ID: Readonly<Record<string, Live2dParameterRole>> = Object.fromEntries(
  (Object.keys(STANDARD_PARAMETERS) as Live2dParameterRole[]).flatMap((role) =>
    STANDARD_PARAMETERS[role].map((id) => [id, role] as const)
  )
)

/** Role a canonical Live2D parameter id belongs to, or undefined if unknown. */
export function live2dParameterRoleOf(parameterId: string): Live2dParameterRole | undefined {
  return ROLE_BY_PARAMETER_ID[parameterId]
}

export function resolveLive2dParameterMapping(
  availableIds: readonly string[],
  overrides: Live2dParameterMapping = {}
): Record<string, string> {
  const available = new Set(
    availableIds.length > 0
      ? availableIds
      : Object.values(STANDARD_PARAMETERS).map((candidates) => candidates[0])
  )
  const result: Record<string, string> = {}
  for (const role of Object.keys(STANDARD_PARAMETERS) as Live2dParameterRole[]) {
    if (overrides[role] === null) continue
    const configured = overrides[role]
    if (configured && available.has(configured)) {
      result[role] = configured
      continue
    }
    const detected = STANDARD_PARAMETERS[role].find((id) => available.has(id))
    if (detected) result[role] = detected
  }
  return result
}

export interface Live2dCoreParameterReader {
  getParameterCount?: () => number
  getParameterId?: (index: number) => string | { getString?: () => string }
}

export function readLive2dParameterIds(core: Live2dCoreParameterReader | undefined): string[] {
  if (!core?.getParameterCount || !core.getParameterId) return []
  const ids: string[] = []
  try {
    const count = core.getParameterCount()
    for (let index = 0; index < count; index += 1) {
      const raw = core.getParameterId(index)
      const id = typeof raw === "string" ? raw : raw.getString?.()
      if (id) ids.push(id)
    }
  } catch {
    return []
  }
  return ids
}
