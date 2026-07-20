export const SPRITE_V2_ATLAS_WIDTH = 1536
export const SPRITE_V2_ATLAS_HEIGHT = 2288
export const MAX_SPRITE_V2_ATLAS_BYTES = 25 * 1024 * 1024

const MAX_ID_LENGTH = 64
const MAX_DISPLAY_NAME_LENGTH = 100
const MAX_DESCRIPTION_LENGTH = 500
const SPRITESHEET_MIME_BY_PATH = {
  "spritesheet.png": "image/png",
  "spritesheet.webp": "image/webp",
} as const

/** Distinct, user-actionable reasons an import can fail. */
export type SpriteV2ImportErrorCode =
  "bad-manifest" | "bad-format" | "too-large" | "already-installed" | "bad-dimensions"

/**
 * Typed import failure carrying a stable `code`, so the import UI can surface a
 * specific translated reason instead of collapsing every failure into one
 * generic message. The `message` stays developer-facing (English, for logs).
 */
export class SpriteV2ImportError extends Error {
  constructor(
    readonly code: SpriteV2ImportErrorCode,
    message: string
  ) {
    super(message)
    this.name = "SpriteV2ImportError"
  }
}

export interface SpriteV2Manifest {
  id: string
  displayName: string
  description: string
  spriteVersionNumber: 2
  spritesheetPath: keyof typeof SPRITESHEET_MIME_BY_PATH
}

export interface SpriteV2InstallPayload {
  id: string
  displayName: string
  description: string
  spriteVersionNumber: 2
  spritesheet: Blob
}

export type ImageDimensionReader = (image: Blob) => Promise<{ width: number; height: number }>

export interface ValidateSpriteV2ImportOptions {
  manifest: unknown
  spritesheet: Blob
  readImageDimensions: ImageDimensionReader
  existingIds?: Iterable<string>
}

/** IDs are filesystem-safe slugs and stay stable across storage and settings. */
export function isValidSpritePackId(id: string): boolean {
  return id.length <= MAX_ID_LENGTH && /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(id)
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SpriteV2ImportError("bad-manifest", "Pet sprite manifest must be an object")
  }
  return value as Record<string, unknown>
}

function boundedText(
  value: unknown,
  field: "displayName" | "description",
  maxLength: number
): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    throw new SpriteV2ImportError("bad-manifest", `Invalid manifest.${field}`)
  }
  return value.trim()
}

function parseManifest(value: unknown): SpriteV2Manifest {
  const raw = record(value)
  if (typeof raw.id !== "string" || !isValidSpritePackId(raw.id)) {
    throw new SpriteV2ImportError(
      "bad-manifest",
      "Invalid manifest.id: use a lowercase slug up to 64 characters"
    )
  }
  const displayName = boundedText(raw.displayName, "displayName", MAX_DISPLAY_NAME_LENGTH)
  const description = boundedText(raw.description, "description", MAX_DESCRIPTION_LENGTH)
  if (raw.spriteVersionNumber !== 2) {
    throw new SpriteV2ImportError(
      "bad-manifest",
      "Invalid manifest.spriteVersionNumber: expected 2"
    )
  }
  if (raw.spritesheetPath !== "spritesheet.png" && raw.spritesheetPath !== "spritesheet.webp") {
    throw new SpriteV2ImportError(
      "bad-manifest",
      "Invalid manifest.spritesheetPath: expected spritesheet.png or spritesheet.webp"
    )
  }
  return {
    id: raw.id,
    displayName,
    description,
    spriteVersionNumber: 2,
    spritesheetPath: raw.spritesheetPath,
  }
}

/**
 * Validate untrusted Codex pet files before they cross the persistence boundary.
 * Image decoding is injected so browser, Tauri, and tests can provide their own
 * safe decoder without coupling this pure validation module to DOM APIs.
 */
export async function validateSpriteV2Import(
  options: ValidateSpriteV2ImportOptions
): Promise<SpriteV2InstallPayload> {
  const manifest = parseManifest(options.manifest)
  const expectedMime = SPRITESHEET_MIME_BY_PATH[manifest.spritesheetPath]
  if (options.spritesheet.type !== "image/png" && options.spritesheet.type !== "image/webp") {
    throw new SpriteV2ImportError(
      "bad-format",
      "Unsupported spritesheet MIME type: expected image/png or image/webp"
    )
  }
  if (options.spritesheet.type !== expectedMime) {
    throw new SpriteV2ImportError(
      "bad-format",
      "Spritesheet MIME type does not match manifest.spritesheetPath"
    )
  }
  if (options.spritesheet.size === 0) {
    throw new SpriteV2ImportError("bad-format", "Spritesheet must not be empty")
  }
  if (options.spritesheet.size > MAX_SPRITE_V2_ATLAS_BYTES) {
    throw new SpriteV2ImportError("too-large", "Spritesheet exceeds the 25 MiB limit")
  }
  if (options.existingIds && new Set(options.existingIds).has(manifest.id)) {
    throw new SpriteV2ImportError(
      "already-installed",
      `Pet sprite pack '${manifest.id}' is already installed`
    )
  }

  let dimensions: { width: number; height: number }
  try {
    dimensions = await options.readImageDimensions(options.spritesheet)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new SpriteV2ImportError(
      "bad-dimensions",
      `Unable to read spritesheet dimensions: ${detail}`
    )
  }
  if (!Number.isFinite(dimensions.width) || !Number.isFinite(dimensions.height)) {
    throw new SpriteV2ImportError(
      "bad-dimensions",
      "Spritesheet decoder returned invalid dimensions"
    )
  }
  if (dimensions.width !== SPRITE_V2_ATLAS_WIDTH || dimensions.height !== SPRITE_V2_ATLAS_HEIGHT) {
    throw new SpriteV2ImportError(
      "bad-dimensions",
      `Invalid spritesheet dimensions ${dimensions.width}x${dimensions.height}; expected ${SPRITE_V2_ATLAS_WIDTH}x${SPRITE_V2_ATLAS_HEIGHT}`
    )
  }

  return {
    id: manifest.id,
    displayName: manifest.displayName,
    description: manifest.description,
    spriteVersionNumber: 2,
    spritesheet: options.spritesheet,
  }
}
