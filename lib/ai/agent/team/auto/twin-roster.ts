/**
 * Gather the Employee Digital Twins (ADR-0003) available to the
 * auto-orchestration composer, so a proposed teammate can be bound to an
 * existing digital employee ("smart mix" — reuse a matching twin, else create a
 * fresh specialist). Thin adapter over `gatherTeamTwins` (the same content-free
 * registry read the run-time recruit path uses), re-shaped with an explicit
 * `twinId` and capped so the composer prompt stays bounded on twin-rich hosts.
 *
 * Never throws — returns `[]` on any failure (the pipeline then simply composes
 * fresh specialists, exactly as before this feature existed).
 */

import { gatherTeamTwins } from "../twin-context"
import type { TwinRosterEntry } from "./types"

/** Per-run cap on how many twins are offered to the composer. */
export const MAX_TWIN_ROSTER = 24

export interface GatherTwinRosterDeps {
  /** Injection seam for tests; defaults to the live registry read. */
  gather?: typeof gatherTeamTwins
}

export async function gatherTwinRoster(
  deps: GatherTwinRosterDeps = {}
): Promise<TwinRosterEntry[]> {
  try {
    const twins = await (deps.gather ?? gatherTeamTwins)()
    return twins
      .slice(0, MAX_TWIN_ROSTER)
      .map((t) => ({ twinId: t.id, name: t.name, expertise: t.expertise }))
  } catch {
    return []
  }
}
