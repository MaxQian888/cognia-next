// JSZip walker for a skill bundle archive. Accepts either a flat layout
// (`SKILL.md` at the zip root) or a single-nested layout
// (`<name>/SKILL.md`); deeper nesting is rejected so the source-of-truth
// for the skill's directory name stays unambiguous. Caps mirror the
// VSIX installer (200 MB total) and the bundle limits module
// (16 MB per file, 50 files per skill).
//
// The walker emits a `BundleArchiveReadResult` that the parent loader
// composes with `parseBundleManifest` to produce the final BundleResult.
// Path validation reuses the shared `validateResourcePath` helper so the
// same rules apply across web inline + Tauri disk writes.

import JSZip from "jszip"
import type { SkillResourceDraft } from "@/lib/db/skill-resources"
import {
  MAX_RESOURCES_PER_SKILL,
  MAX_RESOURCE_BYTES_WEB,
  MAX_ZIP_TOTAL_BYTES,
  validateResourcePath,
} from "./limits"
import { inferResourceKind, isCanonicalBundleDir } from "./classify"

/** Text MIME extensions we inline as utf-8 rather than base64. */
const TEXT_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".mdc",
  ".txt",
  ".text",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".ps1",
  ".bat",
  ".cmd",
  ".py",
  ".pyw",
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".ts",
  ".tsx",
  ".html",
  ".css",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".swift",
  ".sql",
  ".env",
  ".gitignore",
  ".dockerignore",
  ".csv",
  ".tsv",
  ".xml",
  ".svg",
  ".lock",
  ".log",
])

export interface BundleArchiveReadResult {
  /** UTF-8 body of SKILL.md. */
  skillMd: string
  /** UTF-8 body of `agents/openai.yaml` if present, else undefined. */
  openaiYaml?: string
  /**
   * Resources keyed by their inferred kind, with content already encoded
   * (utf-8 or base64). `skillId` is left empty — the caller (`upsert`
   * step) fills it once the Skill row has an id.
   */
  resources: Array<Omit<SkillResourceDraft, "skillId">>
  /** Inferred bundle dir name (the single-nested case) or undefined. */
  rootDirName?: string
  /** Soft warnings — files outside the canonical subdirs, duplicates, etc. */
  warnings: string[]
}

interface RawEntry {
  zipPath: string
  bytes: Uint8Array
}

/**
 * Read every non-directory entry into memory while enforcing the total
 * cap. JSZip's `forEach` is async-unfriendly for limit-checking, so we
 * materialise the list first.
 */
async function collectEntries(zip: JSZip): Promise<RawEntry[]> {
  const entries: RawEntry[] = []
  const files: Array<{ relPath: string; file: JSZip.JSZipObject }> = []
  zip.forEach((relPath, file) => {
    if (file.dir) return
    files.push({ relPath, file })
  })
  let total = 0
  for (const { relPath, file } of files) {
    const bytes = await file.async("uint8array")
    total += bytes.byteLength
    if (total > MAX_ZIP_TOTAL_BYTES) {
      throw new Error(
        `Bundle exceeds the ${MAX_ZIP_TOTAL_BYTES} byte cap (cumulative ${total} bytes after ${relPath}).`
      )
    }
    entries.push({ zipPath: relPath.replace(/\\/g, "/"), bytes })
  }
  return entries
}

/**
 * Find the SKILL.md entry. Accepts flat or single-nested layouts. Returns
 * the bundle root prefix ("" for flat, "name/" for nested) so subsequent
 * entries can be relativised.
 */
function findSkillRoot(entries: RawEntry[]): { rootPrefix: string; skillMdEntry: RawEntry } {
  let chosen: { rootPrefix: string; skillMdEntry: RawEntry } | null = null
  for (const entry of entries) {
    if (
      entry.zipPath.toLowerCase().endsWith("/skill.md") ||
      entry.zipPath.toLowerCase() === "skill.md"
    ) {
      const segments = entry.zipPath.split("/")
      if (segments.length === 1) {
        // Flat: "SKILL.md"
        if (chosen && chosen.rootPrefix !== "") {
          throw new Error("Bundle has multiple SKILL.md files at different depths.")
        }
        chosen = { rootPrefix: "", skillMdEntry: entry }
      } else if (segments.length === 2) {
        // Single-nested: "<name>/SKILL.md"
        const prefix = `${segments[0]}/`
        if (chosen && chosen.rootPrefix !== prefix) {
          throw new Error("Bundle has multiple SKILL.md files at different depths.")
        }
        chosen = { rootPrefix: prefix, skillMdEntry: entry }
      } else {
        throw new Error(
          `Bundle SKILL.md is more than one directory deep (${entry.zipPath}); only flat or single-nested layouts are allowed.`
        )
      }
    }
  }
  if (!chosen) {
    throw new Error("Bundle is missing SKILL.md at the root or one directory in.")
  }
  return chosen
}

/**
 * Convert bytes to either a utf-8 string (text-like extension) or base64
 * (everything else). Falls back to base64 when the utf-8 decode produces
 * a replacement char — defensive against mis-named binary files.
 */
function encodeResource(
  zipPath: string,
  bytes: Uint8Array
): { encoding: "utf-8" | "base64"; content: string } {
  const ext = (zipPath.match(/\.[^./]+$/)?.[0] ?? "").toLowerCase()
  if (TEXT_EXTENSIONS.has(ext)) {
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes)
    if (!text.includes("�")) {
      return { encoding: "utf-8", content: text }
    }
  }
  // Browser-safe base64 encoder.
  let binary = ""
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return { encoding: "base64", content: btoa(binary) }
}

function basename(p: string): string {
  const idx = p.lastIndexOf("/")
  return idx === -1 ? p : p.slice(idx + 1)
}

/**
 * Parse a zipped skill bundle. Returns the SKILL.md body, optional
 * `agents/openai.yaml`, and the collected resources. The caller passes
 * the result + parser output to `materializeSkillBundle`.
 */
export async function readBundleArchive(
  input: Uint8Array | ArrayBuffer
): Promise<BundleArchiveReadResult> {
  const buffer = input instanceof Uint8Array ? input : new Uint8Array(input)
  if (buffer.byteLength > MAX_ZIP_TOTAL_BYTES) {
    throw new Error(
      `Bundle exceeds the ${MAX_ZIP_TOTAL_BYTES} byte cap before unzipping (${buffer.byteLength} bytes).`
    )
  }

  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(buffer)
  } catch (err) {
    throw new Error(
      `Failed to read bundle archive: ${err instanceof Error ? err.message : String(err)}`
    )
  }

  const entries = await collectEntries(zip)
  const { rootPrefix, skillMdEntry } = findSkillRoot(entries)
  const rootDirName = rootPrefix ? rootPrefix.replace(/\/$/, "") : undefined

  const warnings: string[] = []
  const resources: Array<Omit<SkillResourceDraft, "skillId">> = []
  let openaiYaml: string | undefined

  for (const entry of entries) {
    if (entry === skillMdEntry) continue
    if (rootPrefix && !entry.zipPath.startsWith(rootPrefix)) {
      warnings.push(`Skipped ${entry.zipPath}: outside the bundle root ${rootPrefix}.`)
      continue
    }
    const rel = rootPrefix ? entry.zipPath.slice(rootPrefix.length) : entry.zipPath
    if (!rel) continue

    // Codex side-car manifest.
    if (rel === "agents/openai.yaml" || rel === "agents/openai.yml") {
      openaiYaml = new TextDecoder("utf-8").decode(entry.bytes)
      continue
    }

    // Path-traversal / absolute-path guard — same rules as the disk writer.
    const pathError = validateResourcePath(rel)
    if (pathError) {
      throw new Error(`Bundle resource rejected: ${pathError}`)
    }

    // Per-file cap (web inline). Disk-mirror layer enforces its own
    // tighter cap separately and surfaces `tooLargeForDisk`.
    if (entry.bytes.byteLength > MAX_RESOURCE_BYTES_WEB) {
      throw new Error(
        `Bundle resource ${rel} exceeds the ${MAX_RESOURCE_BYTES_WEB} byte per-file cap.`
      )
    }

    // Kind is inferred from the canonical subdir name when present, else
    // per-file by extension (handles Claude Code's `resources/` dir, ad-hoc
    // folders, and root stragglers). Files outside the canonical dirs still
    // get a soft warning so the import dialog can flag the non-standard layout.
    const kind = inferResourceKind(rel)
    if (!isCanonicalBundleDir(rel.split("/")[0])) {
      warnings.push(
        `Resource ${rel} lives outside scripts/ references/ assets/; classified as '${kind}'.`
      )
    }

    if (resources.length >= MAX_RESOURCES_PER_SKILL) {
      warnings.push(
        `Bundle has more than ${MAX_RESOURCES_PER_SKILL} resources; later entries (${rel}…) ignored.`
      )
      break
    }

    const { encoding, content } = encodeResource(rel, entry.bytes)
    resources.push({
      kind,
      name: basename(rel),
      path: rel,
      content,
      encoding,
      size: entry.bytes.byteLength,
    })
  }

  const skillMd = new TextDecoder("utf-8").decode(skillMdEntry.bytes)

  return {
    skillMd,
    openaiYaml,
    resources,
    rootDirName,
    warnings,
  }
}
