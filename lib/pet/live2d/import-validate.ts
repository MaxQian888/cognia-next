import { MAX_MODEL_BYTES } from "./constants"
import { parseLive2dManifest, resolveLive2dReferencePath } from "./manifest"
import { readBlobText } from "./read-blob-text"
import type { ImportValidationResult, Live2dCompatibilityDiagnostic, ModelFileEntry } from "./types"
import { normalizePath } from "./url-resolver"

function isModern(path: string): boolean {
  return path.toLowerCase().endsWith(".model3.json")
}

function isCubism2(path: string): boolean {
  const lower = path.toLowerCase()
  return lower.endsWith(".model.json") && !lower.endsWith(".model3.json")
}

function canonicalEntryPath(path: string): string | null {
  const slash = path.replace(/\\/g, "/")
  if (slash.startsWith("/") || /^[a-z]:\//i.test(slash)) return null
  const output: string[] = []
  for (const segment of slash.split("/")) {
    if (!segment || segment === ".") continue
    if (segment === "..") return null
    output.push(segment)
  }
  return output.join("/") || null
}

function normalizeEntries(
  entries: ModelFileEntry[]
):
  | { ok: true; entries: ModelFileEntry[] }
  | { ok: false; code: "pathTraversal" | "duplicatePath" | "ambiguousPath"; detail: string } {
  const exact = new Set<string>()
  const insensitive = new Map<string, string>()
  const normalized: ModelFileEntry[] = []
  for (const entry of entries) {
    const path = canonicalEntryPath(entry.path)
    if (!path) return { ok: false, code: "pathTraversal", detail: entry.path }
    if (exact.has(path)) return { ok: false, code: "duplicatePath", detail: path }
    const lower = path.toLowerCase()
    const previous = insensitive.get(lower)
    if (previous && previous !== path) {
      return { ok: false, code: "ambiguousPath", detail: `${previous}, ${path}` }
    }
    exact.add(path)
    insensitive.set(lower, path)
    normalized.push({ ...entry, path })
  }
  return { ok: true, entries: normalized }
}

function referenceEscapes(settingsPath: string, reference: string): boolean {
  if (reference.startsWith("/") || /^[a-z]:[\\/]/i.test(reference)) return true
  let depth = settingsPath.replace(/\\/g, "/").split("/").length - 1
  for (const segment of reference.replace(/\\/g, "/").split("/")) {
    if (!segment || segment === ".") continue
    if (segment === "..") {
      depth -= 1
      if (depth < 0) return true
    } else {
      depth += 1
    }
  }
  return false
}

function collectReferences(refs: Record<string, unknown>): string[] {
  const values: string[] = []
  for (const key of ["Moc", "Physics", "Pose", "UserData", "DisplayInfo"] as const) {
    if (typeof refs[key] === "string") values.push(refs[key] as string)
  }
  if (Array.isArray(refs.Textures)) {
    for (const path of refs.Textures) if (typeof path === "string") values.push(path)
  }
  if (Array.isArray(refs.Expressions)) {
    for (const item of refs.Expressions) {
      if (
        typeof item === "object" &&
        item &&
        typeof (item as Record<string, unknown>).File === "string"
      ) {
        values.push((item as Record<string, unknown>).File as string)
      }
    }
  }
  if (typeof refs.Motions === "object" && refs.Motions) {
    for (const group of Object.values(refs.Motions as Record<string, unknown>)) {
      if (!Array.isArray(group)) continue
      for (const item of group) {
        if (typeof item !== "object" || !item) continue
        const record = item as Record<string, unknown>
        if (typeof record.File === "string") values.push(record.File)
        if (typeof record.Sound === "string") values.push(record.Sound)
      }
    }
  }
  return values
}

async function readPrefix(blob: Blob, length: number): Promise<Uint8Array> {
  const sliced = blob.slice(0, length)
  if (typeof sliced.arrayBuffer === "function") return new Uint8Array(await sliced.arrayBuffer())
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
    reader.onerror = () => reject(reader.error ?? new Error("readError"))
    reader.readAsArrayBuffer(sliced)
  })
}

async function isDecodableTexture(entry: ModelFileEntry): Promise<boolean> {
  if (entry.blob.size === 0) return false
  if (!entry.blob.type.startsWith("image/")) return true
  try {
    const bytes = await readPrefix(entry.blob, 12)
    if (entry.blob.type === "image/png") {
      return [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)
    }
    if (entry.blob.type === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8
    if (entry.blob.type === "image/webp") {
      return (
        String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
        String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
      )
    }
    return true
  } catch {
    return false
  }
}

function warning(
  diagnostics: Live2dCompatibilityDiagnostic[],
  code: Live2dCompatibilityDiagnostic["code"],
  path?: string
): void {
  diagnostics.push({ code, severity: "warning", path })
}

/** Remove unusable optional references while preserving the renderable graph. */
function sanitizeSettings(
  settingsPath: string,
  root: Record<string, unknown>,
  present: Set<string>,
  diagnostics: Live2dCompatibilityDiagnostic[]
): Record<string, unknown> {
  const cloned = structuredClone(root)
  const refs = cloned.FileReferences as Record<string, unknown>
  const exists = (path: string) =>
    present.has(normalizePath(resolveLive2dReferencePath(settingsPath, path)))

  for (const [field, code] of [
    ["Physics", "missingPhysics"],
    ["Pose", "missingPose"],
    ["UserData", "missingMetadata"],
    ["DisplayInfo", "missingMetadata"],
  ] as const) {
    const path = refs[field]
    if (typeof path === "string" && !exists(path)) {
      warning(diagnostics, code, resolveLive2dReferencePath(settingsPath, path))
      delete refs[field]
    }
  }

  if (typeof refs.Motions === "object" && refs.Motions) {
    const motions = refs.Motions as Record<string, unknown>
    for (const [group, rawDefinitions] of Object.entries(motions)) {
      if (!Array.isArray(rawDefinitions)) {
        delete motions[group]
        continue
      }
      const usable = rawDefinitions.flatMap((raw) => {
        if (typeof raw !== "object" || !raw) return []
        const definition = { ...(raw as Record<string, unknown>) }
        if (typeof definition.File !== "string" || !exists(definition.File)) {
          warning(
            diagnostics,
            "missingMotion",
            typeof definition.File === "string"
              ? resolveLive2dReferencePath(settingsPath, definition.File)
              : undefined
          )
          return []
        }
        if (typeof definition.Sound === "string" && !exists(definition.Sound)) {
          warning(
            diagnostics,
            "missingSound",
            resolveLive2dReferencePath(settingsPath, definition.Sound)
          )
          delete definition.Sound
        }
        return [definition]
      })
      if (usable.length > 0) motions[group] = usable
      else delete motions[group]
    }
  }

  if (Array.isArray(refs.Expressions)) {
    refs.Expressions = refs.Expressions.filter((raw) => {
      if (typeof raw !== "object" || !raw) return false
      const file = (raw as Record<string, unknown>).File
      if (typeof file === "string" && exists(file)) return true
      warning(
        diagnostics,
        "missingExpression",
        typeof file === "string" ? resolveLive2dReferencePath(settingsPath, file) : undefined
      )
      return false
    })
  }
  return cloned
}

export async function validateLive2dImport(
  rawEntries: ModelFileEntry[]
): Promise<ImportValidationResult> {
  const totalBytes = rawEntries.reduce((sum, entry) => sum + entry.blob.size, 0)
  if (totalBytes > MAX_MODEL_BYTES) {
    return { ok: false, code: "tooLarge", detail: String(totalBytes) }
  }

  const normalized = normalizeEntries(rawEntries)
  if (!normalized.ok) return normalized
  let entries = normalized.entries
  const modern = entries.filter((entry) => isModern(entry.path))
  const cubism2 = entries.filter((entry) => isCubism2(entry.path))
  if (modern.length === 0) {
    return cubism2.length > 0
      ? { ok: false, code: "cubism2Unsupported" }
      : { ok: false, code: "noSettings" }
  }
  if (modern.length > 1) return { ok: false, code: "multipleSettings" }

  const settings = modern[0]
  let jsonText: string
  let root: Record<string, unknown>
  try {
    jsonText = await readBlobText(settings.blob)
    const parsedRoot = JSON.parse(jsonText) as unknown
    if (typeof parsedRoot !== "object" || !parsedRoot || Array.isArray(parsedRoot)) {
      return { ok: false, code: "invalidJson" }
    }
    root = parsedRoot as Record<string, unknown>
  } catch {
    return { ok: false, code: "invalidJson" }
  }

  const parsed = parseLive2dManifest(settings.path, jsonText)
  if (!parsed.ok) return { ok: false, code: parsed.code }
  const refs = root.FileReferences as Record<string, unknown>
  if (collectReferences(refs).some((reference) => referenceEscapes(settings.path, reference))) {
    return { ok: false, code: "pathTraversal" }
  }

  const byPath = new Map(entries.map((entry) => [normalizePath(entry.path), entry]))
  const required = [parsed.manifest.mocPath, ...parsed.manifest.texturePaths]
  const missing = required.filter((path) => !byPath.has(normalizePath(path)))
  if (missing.length > 0) {
    return { ok: false, code: "missingReferenced", detail: missing.join(", ") }
  }
  for (const texture of parsed.manifest.texturePaths) {
    const entry = byPath.get(normalizePath(texture))!
    if (!(await isDecodableTexture(entry))) {
      return { ok: false, code: "corruptTexture", detail: texture }
    }
  }

  const diagnostics: Live2dCompatibilityDiagnostic[] = []
  const sanitizedRoot = sanitizeSettings(settings.path, root, new Set(byPath.keys()), diagnostics)
  const sanitizedText = JSON.stringify(sanitizedRoot)
  const sanitized = parseLive2dManifest(settings.path, sanitizedText)
  if (!sanitized.ok) return { ok: false, code: sanitized.code }
  entries = entries.map((entry) =>
    entry.path === settings.path
      ? { path: entry.path, blob: new Blob([sanitizedText], { type: "application/json" }) }
      : entry
  )
  const textureBytes = sanitized.manifest.texturePaths.reduce(
    (sum, path) => sum + (byPath.get(normalizePath(path))?.blob.size ?? 0),
    0
  )
  return {
    ok: true,
    model: {
      manifest: sanitized.manifest,
      entries,
      totalBytes,
      compatibility: {
        version: 1,
        status: diagnostics.length > 0 ? "degraded" : "ready",
        diagnostics,
        usableMotionGroups: sanitized.manifest.motionGroups,
        usableExpressionIds: sanitized.manifest.expressionIds,
        usableParameterIds: [],
        resourceCost: { totalBytes, fileCount: entries.length, textureBytes },
      },
    },
  }
}
