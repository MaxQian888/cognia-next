import JSZip from "jszip"
import { parseJsonc } from "@/lib/jsonc"
import { readBlobText } from "@/lib/pet/live2d/read-blob-text"
import {
  MAX_MEDIA_PACK_BYTES,
  MAX_MEDIA_PACK_FILES,
  mediaManifestSchema,
  mediaPathSchema,
  referencedMediaFiles,
  type MediaClip,
  type MediaFileEntry,
  type MediaPackAsset,
} from "./manifest"

export type MediaPackImportErrorCode =
  "invalid" | "missingFiles" | "tooLarge" | "ambiguous" | "unsupported" | "decoderMissing"
export class MediaPackImportError extends Error {
  constructor(readonly code: MediaPackImportErrorCode) {
    super(code)
    this.name = "MediaPackImportError"
  }
}
function fail(code: MediaPackImportErrorCode): never {
  throw new MediaPackImportError(code)
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : fail("invalid")
}
function names(value: unknown): string[] {
  if (value === undefined) return []
  const list = typeof value === "string" ? [value] : value
  if (
    !Array.isArray(list) ||
    list.length > 256 ||
    list.some((v) => typeof v !== "string" || !v || v.length > 256)
  )
    return fail("invalid")
  return list as string[]
}
const dirname = (path: string) => path.slice(0, path.lastIndexOf("/") + 1)

async function checkMedia(entry: MediaFileEntry): Promise<MediaFileEntry> {
  const bytes = new Uint8Array(await entry.blob.slice(0, 12).arrayBuffer())
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.slice(from, to))
  let type: string
  if (/\.webm$/i.test(entry.path)) {
    if (![0x1a, 0x45, 0xdf, 0xa3].every((v, i) => bytes[i] === v)) return fail("invalid")
    type = "video/webm"
  } else if (/\.webp$/i.test(entry.path)) {
    if (ascii(0, 4) !== "RIFF" || ascii(8, 12) !== "WEBP") return fail("invalid")
    type = "image/webp"
  } else if (/\.png$/i.test(entry.path)) {
    if (![137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)) return fail("invalid")
    type = "image/png"
  } else return fail("unsupported")
  return {
    path: entry.path,
    blob: entry.blob.type === type ? entry.blob : new Blob([entry.blob], { type }),
  }
}

/** Read only configuration and referenced media; plugin code and credentials never enter the installed pack. */
export async function importMediaPack(entries: MediaFileEntry[]): Promise<MediaPackAsset> {
  if (entries.length > MAX_MEDIA_PACK_FILES) return fail("tooLarge")
  const paths = new Map<string, MediaFileEntry>(),
    folded = new Set<string>()
  let inputBytes = 0
  for (const entry of entries) {
    if (!mediaPathSchema.safeParse(entry.path).success || folded.has(entry.path.toLowerCase()))
      return fail("invalid")
    inputBytes += entry.blob.size
    if (inputBytes > MAX_MEDIA_PACK_BYTES) return fail("tooLarge")
    folded.add(entry.path.toLowerCase())
    paths.set(entry.path, entry)
  }
  let candidates = entries.filter((e) => /(?:^|\/)pet-manifest\.json$/i.test(e.path))
  if (!candidates.length) candidates = entries.filter((e) => /(?:^|\/)config\.jsonc$/i.test(e.path))
  if (!candidates.length)
    candidates = entries.filter((e) => /(?:^|\/)[^/]+-config\.jsonc?$/i.test(e.path))
  if (candidates.length !== 1) return fail(candidates.length ? "ambiguous" : "unsupported")
  const config = candidates[0]
  if (config.blob.size > 2 * 1024 * 1024) return fail("tooLarge")
  let raw: Record<string, unknown>
  try {
    raw = object(parseJsonc(await readBlobText(config.blob)))
  } catch {
    return fail("invalid")
  }
  const base = dirname(config.path)
  const clips: Record<string, MediaClip> = Object.create(null),
    states: Record<string, string[]> = Object.create(null)
  const resolve = (reference: string, dirs: string[]) => {
    if (!mediaPathSchema.safeParse(reference).success) return fail("invalid")
    for (const dir of dirs) if (paths.has(dir + reference)) return dir + reference
    return fail("missingFiles")
  }
  let displayName: string, width: number, height: number, source: "dsh-frames" | "dsh-video"
  let ambient: string[] = []
  if (raw.formatVersion === 1 && raw.clips) {
    source = "dsh-frames"
    displayName =
      typeof raw.characterId === "string"
        ? raw.characterId
        : (config.path.split("/").at(-2) ?? config.path)
    width = Number(raw.maxFrameWidth)
    height = Number(raw.maxFrameHeight)
    for (const [id, value] of Object.entries(object(raw.clips))) {
      const clip = object(value)
      if (
        !Array.isArray(clip.frames) ||
        !clip.frames.length ||
        clip.frames.length > MAX_MEDIA_PACK_FILES
      )
        return fail("invalid")
      clips[id] = {
        kind: "frames",
        frames: clip.frames.map((path) =>
          typeof path === "string" ? resolve(path, [base + "pet/", base, ""]) : fail("invalid")
        ),
        frameMs: Number(clip.frameMs),
        loop: clip.loop === true,
      }
    }
    const mapping = raw.stateMap ? object(raw.stateMap) : {}
    const stateKeys: Record<string, string> = {
      IDLE: "idle",
      THINKING: "thinking",
      WORKING: "interacting",
      WAITING: "waiting",
      SUCCESS: "happy",
      ERROR: "error",
      DISCONNECTED: "idle",
    }
    for (const [from, to] of Object.entries(stateKeys)) {
      const id = mapping[from]
      if (typeof id === "string" && !states[to]) states[to] = [id]
    }
    for (const [to, id] of Object.entries({
      idle: "idle",
      thinking: "thinking",
      interacting: "working",
      waiting: "waiting",
      happy: "success",
      error: "error",
      held: "dragging",
      land: "dragging_release",
      wave: "poke",
      fed: "eat_token",
      pet: "head_pat",
    }))
      if (!states[to] && clips[id]) states[to] = [id]
    ambient = names(raw.idleMicroClips)
  } else if (raw.animations) {
    source = "dsh-video"
    width = 640
    height = 360
    const first = Array.isArray(raw.pets) && raw.pets.length ? object(raw.pets[0]) : {}
    displayName =
      typeof first.name === "string" && first.name
        ? first.name
        : (config.path.split("/").at(-2) ?? config.path)
    const animations = object(raw.animations)
    const addPool = (state: string, value: unknown, loop: boolean) => {
      const pool = names(value)
      if (!pool.length) return
      states[state] = pool
      for (const id of pool) {
        const file = resolve(`${id}.webm`, [
          base + "webm/",
          base + "main-animation/webm/",
          "main-animation/webm/",
          base,
        ])
        clips[id] ??= { kind: "video", file, loop }
      }
    }
    addPool("idle", animations.idle, true)
    addPool("held", animations.drag, true)
    addPool("pet", animations.clicks, false)
    const moves = animations.moves ? object(animations.moves) : {}
    if (Array.isArray(moves.actions))
      addPool(
        "walking",
        moves.actions.map((v) => object(v).name),
        true
      )
    const events = animations.events ? object(animations.events) : {}
    if (events.workStatus !== undefined) {
      if (!Array.isArray(events.workStatus) || events.workStatus.length > 16) return fail("invalid")
      ;["thinking", "interacting", "review", "waiting", "happy", "error"].forEach((state, i) =>
        addPool(state, (events.workStatus as unknown[])[i], i < 4)
      )
    }
    if (animations.categories !== undefined) {
      if (!Array.isArray(animations.categories) || animations.categories.length > 64)
        return fail("invalid")
      for (const category of animations.categories) {
        const settings = object(category)
        const pool = names(settings.actions)
        for (const id of pool) {
          const file = resolve(`${id}.webm`, [
            base + "webm/",
            base + "main-animation/webm/",
            "main-animation/webm/",
            base,
          ])
          clips[id] ??= { kind: "video", file, loop: false }
          if (settings.noMirror === true) clips[id].noMirror = true
        }
        ambient.push(...pool)
      }
    }
  } else return fail("unsupported")
  const parsed = mediaManifestSchema.safeParse({
    version: 1,
    displayName,
    width,
    height,
    source,
    clips,
    states,
    ambient,
  })
  if (!parsed.success) return fail("invalid")
  const media: MediaFileEntry[] = []
  for (const path of referencedMediaFiles(parsed.data))
    media.push(await checkMedia(paths.get(path)!))
  return {
    id: `mp_${crypto.randomUUID()}`,
    manifest: parsed.data,
    entries: media,
    totalBytes: media.reduce((sum, e) => sum + e.blob.size, 0),
    createdAt: Date.now(),
  }
}

/** Bound decompression as it happens; never extract source, scripts or unrelated package payloads. */
export async function extractMediaPackZip(blob: Blob): Promise<MediaFileEntry[]> {
  if (blob.size > MAX_MEDIA_PACK_BYTES) return fail("tooLarge")
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(await blob.arrayBuffer())
  } catch {
    return fail("invalid")
  }
  const files = Object.entries(zip.files).filter(
    ([path, file]) => !file.dir && /\.(jsonc?|webm|webp|png)$/i.test(path)
  )
  if (files.length > MAX_MEDIA_PACK_FILES) return fail("tooLarge")
  const entries: MediaFileEntry[] = []
  let total = 0
  for (const [path, file] of files) {
    const unsafe =
      (file as JSZip.JSZipObject & { unsafeOriginalName?: string }).unsafeOriginalName ?? path
    if (!mediaPathSchema.safeParse(unsafe).success || !mediaPathSchema.safeParse(path).success)
      return fail("invalid")
    const data = await new Promise<Blob>((resolve, reject) => {
      const chunks: Uint8Array<ArrayBuffer>[] = []
      let size = 0
      // JSZip 3 exposes the browser stream used by async(), but omits it from its declarations.
      const stream = (
        file as JSZip.JSZipObject & {
          internalStream(type: "uint8array"): JSZip.JSZipStreamHelper<Uint8Array>
        }
      ).internalStream("uint8array")
      stream
        .on("data", (chunk: Uint8Array) => {
          size += chunk.byteLength
          if (total + size > MAX_MEDIA_PACK_BYTES) {
            stream.pause()
            reject(new MediaPackImportError("tooLarge"))
            return
          }
          chunks.push(new Uint8Array(chunk))
        })
        .on("error", () => reject(new MediaPackImportError("invalid")))
        .on("end", () => resolve(new Blob(chunks)))
        .resume()
    })
    total += data.size
    if (total > MAX_MEDIA_PACK_BYTES) return fail("tooLarge")
    entries.push({ path, blob: data })
  }
  return entries
}
