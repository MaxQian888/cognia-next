/**
 * Render expanded instruction files into a single system-prompt section.
 * Each file becomes a labelled block; blocks are separated by `\n\n---\n\n`
 * (matching the rest of `build-options.ts`'s prompt assembly). Enforces the
 * `maxFiles` / `maxFileBytes` caps and reports anything dropped or truncated —
 * never a silent cap (repo convention).
 */

import type { InstructionFile, ResolvedInstructionsConfig } from "./types"

const PREAMBLE =
  "The following are project instruction files discovered on disk. Treat them as " +
  "authoritative standing context for this workspace; later blocks (closer to the " +
  "working directory) take precedence over earlier ones."

export interface RenderResult {
  section: string
  files: InstructionFile[]
  warnings: string[]
}

export function renderInstructions(
  files: InstructionFile[],
  config: ResolvedInstructionsConfig
): RenderResult {
  const warnings: string[] = []

  let kept = files
  if (files.length > config.maxFiles) {
    kept = files.slice(0, config.maxFiles)
    warnings.push(
      `instruction files capped at ${config.maxFiles}; dropped ${files.length - config.maxFiles} (${files
        .slice(config.maxFiles)
        .map((f) => f.label)
        .join(", ")})`
    )
  }

  const blocks: string[] = []
  for (const f of kept) {
    let body = f.content.trim()
    if (body.length > config.maxFileBytes) {
      body = `${body.slice(0, config.maxFileBytes)}\n…[truncated]`
      warnings.push(`instruction file "${f.label}" truncated to ${config.maxFileBytes} chars`)
    }
    if (!body) continue
    blocks.push(`## ${f.label}\n\n${body}`)
  }

  const section = blocks.length ? `${PREAMBLE}\n\n${blocks.join("\n\n---\n\n")}` : ""
  return { section, files: kept, warnings }
}
