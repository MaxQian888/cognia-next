/**
 * Where an always-on Host runs a dispatched turn's work (ADR-0224 A8).
 *
 * On a headless Host, nothing a task runs may run on the Host by default.
 * Every built-in turn (a phone chat, a scheduled task, a Bot, a goal, a
 * teammate, a plugin's agent turn) goes through `resolveSendOptions`, which
 * asks here. On such a Host the answer is `container`: sandboxed tools are on
 * and run in the session's runtime environment, whatever the session,
 * character or app default chose. The Host decides, because nobody at a
 * desktop is choosing.
 *
 * A project can opt out with `ProjectRuntimeSelection.hostProcess`. Its turns
 * then follow the ordinary ladder, as on any other host. A selection that
 * cannot be read is not an opt-out: the turn stays in a container.
 */

import type { ChatSession } from "@cognia/agent-config-types"
import { isHeadlessHost } from "@/lib/platform/detect"
import type { ProjectRuntimeSelection } from "@/types/project-environment"

export type HostTaskPlacement =
  /** Not an always-on Host: nothing is overridden. */
  | { kind: "not-a-host" }
  /** The project opted out: the ordinary ladder decides. */
  | { kind: "host-process"; projectId: string }
  /** Sandboxed tools on, in the `container` tier. */
  | { kind: "container" }

export interface HostTaskPlacementSources {
  isHost(): boolean
  selection(
    projectId: string,
    environmentId?: string
  ): Promise<{ runtime?: ProjectRuntimeSelection | undefined }>
}

export type HostTaskSession = Pick<ChatSession, "projectId" | "executionContext">

export async function resolveHostTaskPlacement(
  session: HostTaskSession | null | undefined,
  sources: HostTaskPlacementSources = defaultHostTaskPlacementSources()
): Promise<HostTaskPlacement> {
  if (!sources.isHost()) return { kind: "not-a-host" }
  const projectId = session?.executionContext?.projectId || session?.projectId
  if (projectId) {
    const selected = await sources
      .selection(projectId, session?.executionContext?.environmentId)
      .catch(() => undefined)
    if (selected?.runtime?.hostProcess === true) return { kind: "host-process", projectId }
  }
  return { kind: "container" }
}

export function defaultHostTaskPlacementSources(): HostTaskPlacementSources {
  return {
    isHost: isHeadlessHost,
    selection: async (projectId, environmentId) => {
      const { defaultRunEnvironmentSources } = await import("./run-environment")
      return defaultRunEnvironmentSources().selection(projectId, environmentId)
    },
  }
}
