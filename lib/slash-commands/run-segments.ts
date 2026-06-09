// Submit-time orchestrator for a parsed composer input. Given the ordered
// segment list from `parseSegments`, it runs action commands in order, expands
// template commands, accumulates per-turn command overrides, and assembles the
// outgoing message text. Kept pure (no Zustand / sonner / React) so it is
// unit-testable in isolation; the composer supplies the command map, a
// `SlashContext` factory and `applyTemplate`, and applies the result (store
// write + toast) itself.

import type { InputSegment } from "./parse-segments"
import type { SlashCommand } from "./builtin"

export interface PendingCommandOverrides {
  model?: string
  allowedTools?: string[]
  paths?: string[]
}

export interface RunSegmentsDeps {
  /** Live name → command lookup (BUILTIN + custom). */
  commandMap: Map<string, SlashCommand>
  /**
   * Execute an ACTION command (one carrying a `handler`). The composer supplies
   * this so the context-rich `SlashContext` construction + error toast stay in
   * one place (`handleSlashCommand`). A throw is isolated into `errors` and does
   * not abort the rest of the batch.
   */
  runAction: (command: SlashCommand, args: string) => Promise<void> | void
  /** `applyTemplate` from `./builtin` (injected to keep this module pure). */
  applyTemplate: (template: string, args: string) => string
}

export interface CommandError {
  name: string
  message: string
}

export interface RunSegmentsResult {
  /** Final prose to send (template expansions + free text, joined + trimmed). */
  outgoingText: string
  /** Accumulated overrides for the next send, or null when none apply. */
  overrides: PendingCommandOverrides | null
  /** Per-command failures (action handlers that threw); never aborts the batch. */
  errors: CommandError[]
  /** True when at least one action handler ran (affects "send empty turn?"). */
  ranAction: boolean
}

export async function runSegments(
  segments: InputSegment[],
  deps: RunSegmentsDeps
): Promise<RunSegmentsResult> {
  const { commandMap, runAction, applyTemplate } = deps
  const outgoingParts: string[] = []
  const allowedTools = new Set<string>()
  const paths = new Set<string>()
  let model: string | undefined
  let hasOverride = false
  const errors: CommandError[] = []
  let ranAction = false

  for (const seg of segments) {
    if (seg.kind === "text") {
      const trimmed = seg.value.trim()
      if (trimmed) outgoingParts.push(trimmed)
      continue
    }

    const command = commandMap.get(seg.name)
    if (!command) {
      // Defensive: parser only emits known commands, but if the map drifted,
      // keep the literal text rather than dropping it.
      outgoingParts.push(seg.raw)
      continue
    }

    if (command.handler) {
      ranAction = true
      try {
        await runAction(command, seg.args)
      } catch (err) {
        errors.push({
          name: seg.name,
          message: err instanceof Error ? err.message : String(err),
        })
      }
      continue
    }

    if (command.template) {
      const filled = applyTemplate(command.template, seg.args)
      if (filled.trim()) outgoingParts.push(filled)
      if (command.model) {
        model = command.model
        hasOverride = true
      }
      command.allowedTools?.forEach((t) => {
        allowedTools.add(t)
        hasOverride = true
      })
      command.paths?.forEach((p) => {
        paths.add(p)
        hasOverride = true
      })
      continue
    }

    // Neither handler nor template — treat the raw text literally.
    outgoingParts.push(seg.raw)
  }

  const overrides: PendingCommandOverrides | null = hasOverride
    ? {
        model,
        allowedTools: allowedTools.size ? [...allowedTools] : undefined,
        paths: paths.size ? [...paths] : undefined,
      }
    : null

  return {
    outgoingText: outgoingParts.join("\n\n").trim(),
    overrides,
    errors,
    ranAction,
  }
}
