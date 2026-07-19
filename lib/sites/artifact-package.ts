import JSZip from "jszip"

import { createDir, writeBinaryFile } from "@/lib/file/file-operations"
import { sha256Bytes } from "@/lib/ocr/hash"

const ARTIFACT_MANIFEST = ".cognia-artifact.json"

export interface SiteArtifactFile {
  path: string
  bytes: Uint8Array
}

export interface SiteArtifactManifest {
  schemaVersion: 1
  entry: string
  assets?: string
  files: string[]
}

export interface PackagedSiteArtifact {
  bytes: Uint8Array
  digest: string
  fileCount: number
  manifest: SiteArtifactManifest
}

function safeRelativePath(value: string): string {
  const normalized = value.trim().replaceAll("\\", "/").replace(/^\.\//, "")
  if (!normalized || normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized)) {
    throw new Error("Site artifact paths must be relative")
  }
  const output: string[] = []
  for (const part of normalized.split("/")) {
    if (!part || part === ".") continue
    if (part === "..") throw new Error("Site artifact path cannot escape its root")
    output.push(part)
  }
  if (output.length === 0) throw new Error("Site artifact path is empty")
  return output.join("/")
}

export async function packageSiteArtifact(input: {
  entry: string
  assets?: string
  files: SiteArtifactFile[]
}): Promise<PackagedSiteArtifact> {
  const entry = safeRelativePath(input.entry)
  const assets = input.assets ? safeRelativePath(input.assets) : undefined
  const paths = input.files.map((file) => safeRelativePath(file.path))
  if (new Set(paths).size !== paths.length)
    throw new Error("Site artifact contains duplicate paths")
  if (!paths.includes(entry)) throw new Error("Site artifact entry file is missing")
  if (assets && !paths.some((path) => path.startsWith(`${assets}/`))) {
    throw new Error("Site artifact assets directory is empty or missing")
  }
  const ordered = input.files
    .map((file, index) => ({ path: paths[index], bytes: file.bytes }))
    .sort((left, right) => left.path.localeCompare(right.path))
  const manifest: SiteArtifactManifest = {
    schemaVersion: 1,
    entry,
    ...(assets ? { assets } : {}),
    files: ordered.map((file) => file.path),
  }
  const zip = new JSZip()
  const fixedDate = new Date("1980-01-01T00:00:00.000Z")
  zip.file(ARTIFACT_MANIFEST, JSON.stringify(manifest), { date: fixedDate })
  for (const file of ordered) {
    zip.file(file.path, file.bytes, { date: fixedDate, createFolders: false })
  }
  const bytes = await zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    platform: "UNIX",
  })
  return { bytes, digest: await sha256Bytes(bytes), fileCount: ordered.length, manifest }
}

export async function inspectSiteArtifact(bytes: Uint8Array): Promise<SiteArtifactManifest> {
  const zip = await JSZip.loadAsync(bytes)
  const raw = await zip.file(ARTIFACT_MANIFEST)?.async("string")
  if (!raw) throw new Error("Site artifact manifest is missing")
  const parsed = JSON.parse(raw) as Partial<SiteArtifactManifest>
  if (
    parsed.schemaVersion !== 1 ||
    typeof parsed.entry !== "string" ||
    !Array.isArray(parsed.files)
  ) {
    throw new Error("Site artifact manifest is invalid")
  }
  const entry = safeRelativePath(parsed.entry)
  const assets = parsed.assets ? safeRelativePath(parsed.assets) : undefined
  const files = parsed.files.map(safeRelativePath)
  if (new Set(files).size !== files.length || !files.includes(entry)) {
    throw new Error("Site artifact manifest file list is invalid")
  }
  for (const path of files) {
    const file = zip.file(path)
    if (!file || file.dir) throw new Error(`Site artifact file is missing: ${path}`)
  }
  return { schemaVersion: 1, entry, ...(assets ? { assets } : {}), files }
}

export async function materializeSiteArtifact(
  bytes: Uint8Array,
  stagingRoot: string,
  deps: {
    join?: (...parts: string[]) => Promise<string>
    mkdir?: typeof createDir
    write?: typeof writeBinaryFile
  } = {}
): Promise<{ entryPath: string; assetsPath?: string; fileCount: number }> {
  const join =
    deps.join ??
    (async (...parts: string[]) => {
      const paths = await import("@tauri-apps/api/path")
      return paths.join(...parts)
    })
  const mkdir = deps.mkdir ?? createDir
  const write = deps.write ?? writeBinaryFile
  const manifest = await inspectSiteArtifact(bytes)
  const zip = await JSZip.loadAsync(bytes)
  for (const relative of manifest.files) {
    const segments = relative.split("/")
    const target = await join(stagingRoot, ...segments)
    if (segments.length > 1) {
      await mkdir(await join(stagingRoot, ...segments.slice(0, -1)), { recursive: true })
    }
    await write(target, await zip.file(relative)!.async("uint8array"))
  }
  return {
    entryPath: await join(stagingRoot, ...manifest.entry.split("/")),
    ...(manifest.assets
      ? { assetsPath: await join(stagingRoot, ...manifest.assets.split("/")) }
      : {}),
    fileCount: manifest.files.length,
  }
}
