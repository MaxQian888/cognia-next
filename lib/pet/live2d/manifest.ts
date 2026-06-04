// Parses a Cubism `.model3.json` settings file into a resolved manifest.
// Cubism 2 (`.model.json`, legacy `model`/`motions` shape) is NOT supported in
// v1 — there is no official CDN for the legacy core — so it is detected and
// rejected with `cubism2Unsupported`. All paths in the source JSON are relative
// to the settings file's directory; they are resolved to full entry paths here.

import type { Live2DManifest } from "./types"

export type ManifestParseResult =
  | { ok: true; manifest: Live2DManifest }
  | { ok: false; code: "invalidJson" | "cubism2Unsupported" }

/** Directory portion of a POSIX-style path ("a/b/c.json" → "a/b"). */
function dirname(path: string): string {
  const slash = path.lastIndexOf("/")
  return slash === -1 ? "" : path.slice(0, slash)
}

/**
 * Join a base directory with a relative reference and normalize "." / ".."
 * segments. Backslashes are treated as separators so Windows-authored zips
 * resolve identically.
 */
function joinPosix(baseDir: string, ref: string): string {
  const combined = ref.startsWith("/") ? ref : baseDir ? `${baseDir}/${ref}` : ref
  const out: string[] = []
  for (const segment of combined.replace(/\\/g, "/").split("/")) {
    if (segment === "" || segment === ".") continue
    if (segment === "..") {
      out.pop()
      continue
    }
    out.push(segment)
  }
  return out.join("/")
}

interface CubismFileReferences {
  Moc?: unknown
  Textures?: unknown
  Physics?: unknown
  Pose?: unknown
  Motions?: unknown
  Expressions?: unknown
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

/**
 * Parse the settings JSON for `settingsPath`. Modern models expose
 * `FileReferences.{Moc,Textures,Motions,Expressions,Physics,Pose}`; anything
 * shaped like Cubism 2 (filename `*.model.json`, or top-level `model`/`motions`)
 * is rejected.
 */
export function parseLive2dManifest(settingsPath: string, jsonText: string): ManifestParseResult {
  const lowerSettings = settingsPath.toLowerCase()
  // Cubism 2 settings are named `*.model.json` (not `*.model3.json`).
  const looksLikeCubism2ByName =
    lowerSettings.endsWith(".model.json") && !lowerSettings.endsWith(".model3.json")

  let json: unknown
  try {
    json = JSON.parse(jsonText)
  } catch {
    return { ok: false, code: "invalidJson" }
  }

  if (typeof json !== "object" || json === null) {
    return { ok: false, code: "invalidJson" }
  }

  const root = json as Record<string, unknown>

  // Legacy Cubism 2 shape: top-level `model` + `textures`/`motions`.
  const looksLikeCubism2ByShape =
    typeof root.model === "string" && (root.motions !== undefined || root.textures !== undefined)

  if (looksLikeCubism2ByName || looksLikeCubism2ByShape) {
    return { ok: false, code: "cubism2Unsupported" }
  }

  const fileRefs = root.FileReferences
  if (typeof fileRefs !== "object" || fileRefs === null) {
    return { ok: false, code: "invalidJson" }
  }
  const refs = fileRefs as CubismFileReferences

  const moc = asString(refs.Moc)
  if (!moc) {
    return { ok: false, code: "invalidJson" }
  }

  const baseDir = dirname(settingsPath)

  const textures = Array.isArray(refs.Textures)
    ? refs.Textures.filter((t): t is string => typeof t === "string").map((t) =>
        joinPosix(baseDir, t)
      )
    : []

  const motionGroups =
    typeof refs.Motions === "object" && refs.Motions !== null
      ? Object.keys(refs.Motions as Record<string, unknown>)
      : []

  const expressionIds = Array.isArray(refs.Expressions)
    ? refs.Expressions.map((e) =>
        typeof e === "object" && e !== null
          ? asString((e as Record<string, unknown>).Name)
          : undefined
      ).filter((n): n is string => typeof n === "string")
    : []

  const physics = asString(refs.Physics)
  const pose = asString(refs.Pose)

  const manifest: Live2DManifest = {
    kind: "modern",
    settingsPath,
    mocPath: joinPosix(baseDir, moc),
    texturePaths: textures,
    motionGroups,
    expressionIds,
    ...(physics ? { physicsPath: joinPosix(baseDir, physics) } : {}),
    ...(pose ? { posePath: joinPosix(baseDir, pose) } : {}),
  }

  return { ok: true, manifest }
}
