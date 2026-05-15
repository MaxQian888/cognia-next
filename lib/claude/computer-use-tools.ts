/**
 * Resolve Anthropic Computer Use native tools for a chat turn.
 *
 * Called from `lib/claude/build-options.ts:resolveSendOptions` after the
 * character + skills + provider have been resolved. The function:
 *
 *   1. Returns immediately when `character.enableComputerUse !== true`.
 *   2. Reads the dynamic tool registry
 *      (`lib/plugin/registries/native-anthropic-tool-registry`).
 *   3. Filters by `character.computerUseSettings.allowedToolIds` when set.
 *   4. Maps each entry to the wire shape on `SendOptions.anthropicTools`.
 *   5. Computes the `anthropic-beta` header via `computeAnthropicBetaHeaders`
 *      and folds it into `SendOptions.appendHeaders["anthropic-beta"]`.
 *
 * Pure helper — no React, no I/O beyond the in-memory registry. Same
 * convention as `lib/goal/context-injector:appendGoalContext`.
 */

import {
  computeAnthropicBetaHeaders,
  listNativeAnthropicToolEntries,
} from "@/lib/plugin/registries/native-anthropic-tool-registry"
import type { Character, SendOptions } from "@/lib/claude/types"

export interface ApplyComputerUseInput {
  character: Character | null | undefined
  opts: SendOptions
}

export interface ApplyComputerUseResult {
  /**
   * SendOptions updated in-place style: caller assigns the returned object
   * back to its local `opts`. Keeps the build-options resolver linear.
   */
  opts: SendOptions
  /**
   * Number of Anthropic tools that ended up on `opts.anthropicTools`.
   * Useful for callers that want to short-circuit follow-on work (e.g.,
   * skip the canUseTool wiring when zero).
   */
  attachedCount: number
}

export function applyComputerUseTools(input: ApplyComputerUseInput): ApplyComputerUseResult {
  const { character } = input
  const opts = { ...input.opts }
  if (!character?.enableComputerUse) {
    return { opts, attachedCount: 0 }
  }

  const entries = listNativeAnthropicToolEntries()
  if (entries.length === 0) {
    return { opts, attachedCount: 0 }
  }

  const allowedIds = character.computerUseSettings?.allowedToolIds
  const allowedSet = allowedIds && allowedIds.length > 0 ? new Set(allowedIds) : null
  const filtered = allowedSet ? entries.filter((e) => allowedSet.has(e.id)) : entries

  if (filtered.length === 0) {
    return { opts, attachedCount: 0 }
  }

  // Map registry entries → wire shape. The renderer-only `executeIpc.invoke`
  // string travels with each tool so the sidecar can route `tool_use`
  // messages back without re-reading the registry.
  opts.anthropicTools = filtered.map((row) => {
    const def = row.entry
    return {
      name: def.name,
      type: def.type,
      betaHeader: def.betaHeader,
      displayWidthPx: def.displayWidthPx,
      displayHeightPx: def.displayHeightPx,
      displayNumber: def.displayNumber,
      enableZoom: def.enableZoom,
      executeIpc: def.executeIpc,
      permissionPolicy: def.permissionPolicy,
    }
  })

  // Compose the beta header from the *original* tool defs so the
  // computeAnthropicBetaHeaders helper sees the canonical
  // `PluginNativeAnthropicToolDef` shape.
  const beta = computeAnthropicBetaHeaders(filtered.map((row) => row.entry))
  if (beta.length > 0) {
    const existingHeader = opts.appendHeaders?.["anthropic-beta"]
    const next = existingHeader ? `${existingHeader},${beta.join(",")}` : beta.join(",")
    opts.appendHeaders = {
      ...(opts.appendHeaders ?? {}),
      "anthropic-beta": dedupCsv(next),
    }
  }

  return { opts, attachedCount: filtered.length }
}

/**
 * De-duplicate a comma-separated header value while preserving first-seen
 * order. Idempotent — callers can merge multiple times without poisoning
 * the header.
 */
function dedupCsv(value: string): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of value.split(",")) {
    const trimmed = part.trim()
    if (!trimmed) continue
    if (seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out.join(",")
}
