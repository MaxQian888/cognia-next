// Public entry point of the skill-bundle loader. Composes the file walkers
// (`walk-zip`, `walk-folder`) with the manifest parser (`parse`) and the
// optional Codex sidecar parser. The output is a `BundleResult` whose
// shape is consumed by:
//
//   1. The chat-import path — `lib/skills/bundle/upsert` (task #3) folds
//      the result into Dexie via the shared `upsertSkillByCanonicalId`
//      helper.
//   2. The plugin path — `lib/claude/skills-io:resolveSkillMarkdown`
//      (task #7) uses the result to materialise plugin-shipped
//      `local-bundle` / `archive` skill sources at runtime.
//
// The loader is deliberately decoupled from disk persistence: nothing
// here writes to Dexie or the filesystem. That separation keeps the
// loader reusable across web/mobile (in-memory inline) and Tauri
// (disk-first) without conditionals.

import type { SkillDraft } from "@/lib/db/skills"
import type { SkillResourceDraft } from "@/lib/db/skill-resources"
import type { SkillValidationError } from "@cognia/agent-config-types"
import { parseBundleManifest, type BundleFlavor } from "./parse"
import type { CodexOpenaiMeta } from "./codex-yaml"
import { readBundleArchive } from "./walk-zip"
import { readBundleFolder, type BundleFs } from "./walk-folder"

export type BundleInput =
  | { kind: "zip-blob"; bytes: Uint8Array | ArrayBuffer; fallbackName?: string }
  | { kind: "zip-path"; path: string; fallbackName?: string }
  | { kind: "folder"; path: string; fallbackName?: string; fs?: BundleFs }

export interface BundleResult {
  /** Ready to feed into `bulkImportSkills` / `upsertSkillByCanonicalId`. */
  draft: SkillDraft
  /** Resources keyed by their inferred kind. `skillId` left blank. */
  resources: Array<Omit<SkillResourceDraft, "skillId">>
  flavor: BundleFlavor
  /** Parsed Codex `agents/openai.yaml` payload when the file was present. */
  codexMeta?: CodexOpenaiMeta
  /** Bundle directory name (zip nested layout or folder basename). */
  rootDirName?: string
  /**
   * Non-fatal validation findings — persisted on the resulting `Skill`
   * row's `validationErrors` field so the editor flags them.
   */
  nonFatalValidationErrors: SkillValidationError[]
  /** All accumulated soft warnings from the walker + parser. */
  warnings: string[]
}

/**
 * Read a zip file from disk via the Tauri fs plugin. Imported lazily so
 * this module stays jsdom-safe.
 */
async function readZipFromDisk(path: string): Promise<Uint8Array> {
  const fs = await import("@tauri-apps/plugin-fs")
  return await fs.readFile(path)
}

/**
 * Load a skill bundle from any of three sources. Throws on fatal
 * validation errors (`missing-name`, `missing-content`) — the dialog
 * catches and surfaces the message. Other findings ride along on the
 * `warnings` / `nonFatalValidationErrors` fields.
 */
export async function loadBundle(input: BundleInput): Promise<BundleResult> {
  let archive: {
    skillMd: string
    openaiYaml?: string
    resources: Array<Omit<SkillResourceDraft, "skillId">>
    rootDirName?: string
    warnings: string[]
  }
  let fallbackName: string | undefined

  switch (input.kind) {
    case "zip-blob": {
      const bytes = input.bytes instanceof Uint8Array ? input.bytes : new Uint8Array(input.bytes)
      archive = await readBundleArchive(bytes)
      fallbackName = input.fallbackName ?? archive.rootDirName
      break
    }
    case "zip-path": {
      const bytes = await readZipFromDisk(input.path)
      archive = await readBundleArchive(bytes)
      fallbackName =
        input.fallbackName ??
        archive.rootDirName ??
        input.path
          .replace(/\\/g, "/")
          .replace(/\.zip$/i, "")
          .split("/")
          .pop() ??
        undefined
      break
    }
    case "folder": {
      archive = await readBundleFolder(input.path, input.fs)
      fallbackName = input.fallbackName ?? archive.rootDirName
      break
    }
    default: {
      // Exhaustive narrowing — compile-time guarantee that we covered all
      // BundleInput variants. If a new variant is added the compiler will
      // flag the missing case.
      const exhaustive: never = input
      throw new Error(`Unknown bundle input kind: ${(exhaustive as { kind: string }).kind}`)
    }
  }

  const parsed = parseBundleManifest({
    skillMd: archive.skillMd,
    openaiYaml: archive.openaiYaml,
    fallbackName,
    directoryName: archive.rootDirName,
  })
  let inlinePaths = new Set<string>()
  const inlineMetadata = parsed.draft.metadata?.["cognia.inline-resources"]
  if (inlineMetadata) {
    try {
      const value: unknown = JSON.parse(inlineMetadata)
      if (Array.isArray(value)) {
        inlinePaths = new Set(value.filter((item): item is string => typeof item === "string"))
      }
    } catch {
      parsed.warnings.push("cognia.inline-resources metadata is not a valid JSON string array.")
    }
  }

  return {
    draft: parsed.draft,
    resources: archive.resources.map((resource) => ({
      ...resource,
      inline: inlinePaths.has(resource.path) || undefined,
    })),
    flavor: parsed.flavor,
    codexMeta: parsed.codexMeta,
    rootDirName: archive.rootDirName,
    nonFatalValidationErrors: parsed.nonFatalValidationErrors,
    warnings: [...archive.warnings, ...parsed.warnings],
  }
}
