import type {
  PetAssetDiagnostic,
  PetSkinCapabilities,
  PetSkinId,
  PetSkinSelection,
} from "@/types/pet"

export const PET_SKIN_CAPABILITIES: Readonly<Record<PetSkinId, PetSkinCapabilities>> = {
  svg: {
    semanticStates: true,
    oneShots: true,
    locomotion: true,
    facing: true,
    heldPose: true,
    speaking: true,
    mood: true,
    flavor: true,
    gaze: true,
    pause: true,
    reducedMotion: true,
    lowPower: true,
  },
  live2d: {
    semanticStates: true,
    oneShots: true,
    locomotion: true,
    facing: true,
    heldPose: true,
    speaking: true,
    mood: true,
    flavor: true,
    gaze: true,
    pause: true,
    reducedMotion: true,
    lowPower: true,
  },
  "sprite-v2": {
    semanticStates: true,
    oneShots: true,
    locomotion: true,
    facing: true,
    heldPose: true,
    speaking: true,
    mood: true,
    flavor: true,
    gaze: true,
    pause: true,
    reducedMotion: true,
    lowPower: true,
  },
}

export interface NormalizeSelectionAssets {
  modelId?: string
  packId?: string
  coreReady?: boolean
  modelReady?: boolean
  packReady?: boolean
}

export interface NormalizedPetSkinSelection {
  requestedSkinId: string
  selection: PetSkinSelection
  diagnostics: PetAssetDiagnostic[]
}

function fallbackDiagnostic(
  code: "unknownSkin" | "assetMissing" | "runtimeUnavailable",
  detail?: string
): PetAssetDiagnostic {
  return { code, severity: "error", detail, recoverable: true }
}

/** Normalize persisted/legacy values without ever leaving the renderer empty. */
export function normalizePetSkinSelection(
  requestedSkinId: string | undefined,
  assets: NormalizeSelectionAssets
): NormalizedPetSkinSelection {
  const requested = requestedSkinId ?? "svg"
  if (requested === "svg") {
    return { requestedSkinId: requested, selection: { skinId: "svg" }, diagnostics: [] }
  }
  if (requested === "live2d") {
    if (!assets.modelId || assets.modelReady === false) {
      return {
        requestedSkinId: requested,
        selection: { skinId: "svg" },
        diagnostics: [fallbackDiagnostic("assetMissing", assets.modelId)],
      }
    }
    if (assets.coreReady === false) {
      return {
        requestedSkinId: requested,
        selection: { skinId: "svg" },
        diagnostics: [fallbackDiagnostic("runtimeUnavailable")],
      }
    }
    return {
      requestedSkinId: requested,
      selection: { skinId: "live2d", modelId: assets.modelId },
      diagnostics: [],
    }
  }
  if (requested === "sprite-v2") {
    if (!assets.packId || assets.packReady === false) {
      return {
        requestedSkinId: requested,
        selection: { skinId: "svg" },
        diagnostics: [fallbackDiagnostic("assetMissing", assets.packId)],
      }
    }
    return {
      requestedSkinId: requested,
      selection: { skinId: "sprite-v2", packId: assets.packId },
      diagnostics: [],
    }
  }
  return {
    requestedSkinId: requested,
    selection: { skinId: "svg" },
    diagnostics: [fallbackDiagnostic("unknownSkin", requested)],
  }
}

export type PetBehaviorLayer =
  "suspended" | "held" | "oneShot" | "locomotion" | "semanticState" | "gaze" | "idle"

/** One precedence policy used by SVG, Live2D and Sprite renderers. */
export function resolvePetBehaviorLayer(input: {
  suspended?: boolean
  reduced?: boolean
  held?: boolean
  oneShot?: boolean
  locomotion?: boolean
  semanticState?: boolean
  gaze?: boolean
}): PetBehaviorLayer {
  if (input.suspended || input.reduced) return "suspended"
  if (input.held) return "held"
  if (input.oneShot) return "oneShot"
  if (input.locomotion) return "locomotion"
  if (input.semanticState) return "semanticState"
  if (input.gaze) return "gaze"
  return "idle"
}

export interface SpriteLookCell {
  row: 9 | 10
  frame: number
  index: number
}

const LOOK_BUCKET_RADIANS = Math.PI / 8
const LOOK_DEAD_ZONE = 0.2
const LOOK_HYSTERESIS_RADIANS = (4 * Math.PI) / 180
const LOOK_STALE_MS = 2_000

function circularDistance(a: number, b: number): number {
  const raw = Math.abs(a - b) % 16
  return Math.min(raw, 16 - raw)
}

/** Quantize up-first, clockwise gaze into rows 9–10 of the v2 atlas. */
export function quantizeSpriteLookDirection(
  target: { x: number; y: number; updatedAt?: number },
  opts: { now?: number; previousIndex?: number } = {}
): SpriteLookCell | null {
  const now = opts.now ?? Date.now()
  if (target.updatedAt !== undefined && now - target.updatedAt > LOOK_STALE_MS) return null
  const x = Math.max(-1, Math.min(1, target.x))
  const y = Math.max(-1, Math.min(1, target.y))
  if (Math.hypot(x, y) < LOOK_DEAD_ZONE) return null

  const angle = (Math.atan2(x, -y) + Math.PI * 2) % (Math.PI * 2)
  let index = Math.round(angle / LOOK_BUCKET_RADIANS) % 16
  const previous = opts.previousIndex
  if (previous !== undefined && circularDistance(previous, index) === 1) {
    const previousCenter = previous * LOOK_BUCKET_RADIANS
    const delta = Math.abs(
      Math.atan2(Math.sin(angle - previousCenter), Math.cos(angle - previousCenter))
    )
    if (delta < LOOK_BUCKET_RADIANS / 2 + LOOK_HYSTERESIS_RADIANS) index = previous
  }
  return { row: index < 8 ? 9 : 10, frame: index % 8, index }
}
