import { z } from "zod"

export const MAX_MEDIA_PACK_BYTES = 128 * 1024 * 1024
export const MAX_MEDIA_PACK_FILES = 5000
export const MAX_MEDIA_FRAMES = 5000

export const mediaPathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path.includes("\\") &&
      !path.includes(":") &&
      !path.includes("\0") &&
      !path.split("/").some((part) => part === ".." || part === "." || !part)
  )
const clipBase = { loop: z.boolean(), noMirror: z.boolean().optional() }
export const mediaClipSchema = z.discriminatedUnion("kind", [
  z.object({ ...clipBase, kind: z.literal("video"), file: mediaPathSchema }),
  z.object({
    ...clipBase,
    kind: z.literal("frames"),
    frames: z.array(mediaPathSchema).min(1).max(MAX_MEDIA_FRAMES),
    frameMs: z.number().min(16).max(2000),
  }),
  z.object({
    ...clipBase,
    kind: z.literal("atlas"),
    file: mediaPathSchema,
    frameWidth: z.number().int().min(1).max(1024),
    frameHeight: z.number().int().min(1).max(1024),
    columns: z.number().int().min(1).max(32),
    frameCount: z.number().int().min(1).max(360),
    frameMs: z.number().min(16).max(2000),
  }),
])
export const mediaManifestSchema = z
  .object({
    version: z.literal(1),
    displayName: z.string().min(1).max(200),
    width: z.number().int().min(1).max(4096),
    height: z.number().int().min(1).max(4096),
    source: z.enum(["dsh-video", "dsh-frames", "cognia"]),
    clips: z
      .record(z.string().min(1).max(256), mediaClipSchema)
      .refine((clips) => Object.keys(clips).length > 0 && Object.keys(clips).length <= 256),
    states: z.record(z.string().max(64), z.array(z.string().max(256)).min(1).max(256)),
    ambient: z.array(z.string().max(256)).max(256).default([]),
  })
  .superRefine((value, ctx) => {
    if (!value.states.idle?.length)
      ctx.addIssue({ code: "custom", message: "Missing idle animation" })
    for (const id of [...Object.values(value.states).flat(), ...value.ambient])
      if (!Object.hasOwn(value.clips, id))
        ctx.addIssue({ code: "custom", message: "Unknown animation" })
  })

export type MediaClip = z.infer<typeof mediaClipSchema>
export type MediaPackManifest = z.infer<typeof mediaManifestSchema>
export interface MediaFileEntry {
  path: string
  blob: Blob
}
export interface MediaPackAsset {
  id: string
  manifest: MediaPackManifest
  entries: MediaFileEntry[]
  totalBytes: number
  createdAt: number
}

export function clipFiles(clip: MediaClip): string[] {
  return clip.kind === "frames" ? clip.frames : [clip.file]
}

export function referencedMediaFiles(manifest: MediaPackManifest): string[] {
  return [...new Set(Object.values(manifest.clips).flatMap(clipFiles))]
}

export function validateMediaAsset(value: unknown): value is MediaPackAsset {
  if (!value || typeof value !== "object") return false
  const asset = value as MediaPackAsset
  const parsed = mediaManifestSchema.safeParse(asset.manifest)
  if (
    !parsed.success ||
    !/^mp_[a-zA-Z0-9_-]{1,100}$/.test(asset.id) ||
    !Array.isArray(asset.entries) ||
    asset.entries.length > MAX_MEDIA_PACK_FILES
  )
    return false
  const paths = new Set<string>()
  let bytes = 0
  for (const entry of asset.entries) {
    if (
      !entry ||
      typeof entry !== "object" ||
      !mediaPathSchema.safeParse(entry.path).success ||
      !(entry.blob instanceof Blob) ||
      paths.has(entry.path)
    )
      return false
    paths.add(entry.path)
    bytes += entry.blob.size
    if (bytes > MAX_MEDIA_PACK_BYTES) return false
  }
  return (
    bytes === asset.totalBytes &&
    Number.isFinite(asset.createdAt) &&
    referencedMediaFiles(parsed.data).every((path) => paths.has(path))
  )
}
