/**
 * Apply the hunks a user selected (ADR-0238 §7.8).
 *
 * Hunks are grouped by surface and each surface is one edit: re-read now,
 * patched only if every hunk's `before` lines are still there, then written
 * through the host — which asks the user to confirm that surface's change and
 * routes it to the owner (a file, a Prompt Center override, a custom copy of a
 * shipped resource). A move touches two surfaces; its destination is written
 * first, so a refused or stale source leaves the rule duplicated, never lost.
 */

import type { PluginAgentConfigAPI } from "@cognia/plugin-sdk"

import { applyHunks, StaleHunkError } from "../engine/diff"
import type { AuditRun, Hunk } from "../model"
import type { AppliedChange } from "./store"

export type SurfaceApplyStatus = "applied" | "stale" | "declined" | "gone" | "failed"

export interface SurfaceApplyResult {
  surfaceKey: string
  status: SurfaceApplyStatus
  hunks: number
  /** Where the text now lives, when applied. */
  resultKey?: string
  error?: string
}

export interface ApplyDeps {
  agentConfig: PluginAgentConfigAPI
  now(): number
  newId(): string
  /** The one-line summary the confirmation shows. */
  summarize(surfaceName: string, hunks: number): string
  record(change: AppliedChange): Promise<void>
}

/** Hunks of the selected findings, by surface, destinations of moves first. */
export function planApply(
  run: AuditRun,
  findingIds: ReadonlySet<string>
): Array<{ surfaceKey: string; hunks: Hunk[] }> {
  const groups = new Map<string, Hunk[]>()
  for (const hunk of run.hunks) {
    if (!findingIds.has(hunk.findingId)) continue
    const list = groups.get(hunk.surfaceKey) ?? []
    list.push(hunk)
    groups.set(hunk.surfaceKey, list)
  }
  const moveDestinations = new Set(
    run.findings
      .filter(
        (finding) => finding.action === "move" && finding.moveTo && findingIds.has(finding.id)
      )
      .map((finding) => finding.moveTo!)
  )
  return [...groups.entries()]
    .map(([surfaceKey, hunks]) => ({ surfaceKey, hunks }))
    .sort(
      (a, b) =>
        Number(moveDestinations.has(b.surfaceKey)) - Number(moveDestinations.has(a.surfaceKey))
    )
}

function errorCode(error: unknown): string | undefined {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined
  return typeof code === "string" ? code : undefined
}

export async function applySelected(
  deps: ApplyDeps,
  run: AuditRun,
  findingIds: ReadonlySet<string>
): Promise<SurfaceApplyResult[]> {
  const results: SurfaceApplyResult[] = []
  const names = new Map(run.surfaces.map((entry) => [entry.surface.key, entry.surface.name]))
  for (const { surfaceKey, hunks } of planApply(run, findingIds)) {
    const name = names.get(surfaceKey) ?? surfaceKey
    try {
      const document = await deps.agentConfig.readSurface(surfaceKey, {
        workspaceId: run.workspaceId,
      })
      if (!document) {
        results.push({ surfaceKey, status: "gone", hunks: hunks.length })
        continue
      }
      const text = applyHunks(document.text, hunks)
      const written = await deps.agentConfig.applyEdit({
        key: surfaceKey,
        text,
        ...(document.version ? { version: document.version } : {}),
        workspaceId: run.workspaceId,
        summary: deps.summarize(name, hunks.length),
      })
      const findingsOfSurface = [...new Set(hunks.map((hunk) => hunk.findingId))]
      await deps.record({
        id: deps.newId(),
        at: deps.now(),
        workspaceId: run.workspaceId,
        surfaceKey,
        resultKey: written.key,
        surfaceName: name,
        findingIds: findingsOfSurface,
        hunks: hunks.length,
      })
      results.push({ surfaceKey, status: "applied", hunks: hunks.length, resultKey: written.key })
    } catch (error) {
      if (error instanceof StaleHunkError) {
        results.push({ surfaceKey, status: "stale", hunks: hunks.length })
      } else if (errorCode(error) === "agent_config_consent_denied") {
        results.push({ surfaceKey, status: "declined", hunks: hunks.length })
      } else if (errorCode(error) === "agent_config_stale") {
        results.push({ surfaceKey, status: "stale", hunks: hunks.length })
      } else {
        results.push({
          surfaceKey,
          status: "failed",
          hunks: hunks.length,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }
  return results
}
