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
