/**
 * Which cogset should be running right now (ADR-0209).
 *
 * In order: a session override (a switch made while a workspace had its own
 * binding), the active workspace's binding, the global choice. A reference to
 * a cogset that no longer exists is skipped rather than obeyed, so deleting a
 * cogset can never leave the host trying to reach it.
 */

import type { EffectiveCogsetSource } from "@/types/plugin/plugin-cogset"

export interface EffectiveCogsetInput {
  sessionOverrideId?: string
  workspaceCogsetId?: string
  globalCogsetId?: string
}

export interface EffectiveCogset {
  cogsetId: string
  source: EffectiveCogsetSource
}

export async function resolveEffectiveCogset(
  input: EffectiveCogsetInput,
  exists: (id: string) => Promise<boolean>
): Promise<EffectiveCogset | null> {
  const candidates: Array<[string | undefined, EffectiveCogsetSource]> = [
    [input.sessionOverrideId, "session"],
    [input.workspaceCogsetId, "workspace"],
    [input.globalCogsetId, "global"],
  ]
  for (const [cogsetId, source] of candidates) {
    if (cogsetId && (await exists(cogsetId))) return { cogsetId, source }
  }
  return null
}
