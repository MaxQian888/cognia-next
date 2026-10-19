"use client"

/**
 * HarnessEvolutionInitializer — the boot wiring of Harness Evolution
 * (ADR-0237), desktop only:
 *
 *  - adopted tool rules apply live to the agents that carry them;
 *  - approval notifications get their Approve / Keep-current handler;
 *  - runs whose driver died with the app are marked interrupted (resumed
 *    only on a person's request: a resume spends again);
 *  - in background mode, a turn that fails through the agent's own conduct
 *    queues a run for the scheduled sweep to start.
 */

import { useEffect } from "react"

import { loggers } from "@cognia/logging"
import type { CogniaDiagnostic } from "@cognia/diagnostics"
import { isHarnessFailure } from "@/lib/harness/failure-offer"
import { useChatStore } from "@/stores/chat/chat-store"
import { useSettingsStore } from "@/stores/settings"

let started = false

/** Queue a background run for one failed turn, when background mode is on. */
export async function handleFailedTurn(
  sessionId: string,
  diagnostic: CogniaDiagnostic
): Promise<void> {
  const harness = useSettingsStore.getState().settings?.harnessEvolution
  if (!harness?.enabled || harness.startMode !== "background") return
  const [{ hostOwnsSessionState }, { getRuntimeSnapshot }] = await Promise.all([
    import("@/lib/db/mobile-outbound-queue"),
    import("@/lib/runtime/runtime-snapshot-store"),
  ])
  // A client whose host owns the conversations queues nothing: the host sees
  // the same failure and owns the runs.
  if (hostOwnsSessionState(getRuntimeSnapshot())) return
  const [sessions, cwd, conversation, failureOffer, trigger] = await Promise.all([
    import("@/lib/db/sessions"),
    import("@/hooks/chat/use-effective-cwd"),
    import("@/lib/a2ui/from-execution/conversation"),
    import("@/lib/harness/failure-offer"),
    import("@/lib/harness/runtime/failure-trigger"),
  ])
  const session = await sessions.getSession(sessionId)
  if (!session?.characterId) return
  const messages = useChatStore.getState().sessions[sessionId]?.messages ?? []
  const request = failureOffer.lastUserRequest(messages, (parts) =>
    conversation.extractMessageText(parts as never)
  )
  if (!request) return
  const outcome = await trigger.enqueueRunForFailure(
    {
      sessionId,
      characterId: session.characterId,
      ...(session.projectId ? { projectId: session.projectId } : {}),
      workingDirectory: await cwd.resolveEffectiveCwdForSession(session),
      diagnostic,
      prompt: request.text,
      messageId: request.id,
    },
    await trigger.defaultFailureTriggerDeps()
  )
  if (outcome.kind === "enqueued") {
    loggers.agent.info("harness evolution queued a background run", {
      sessionId,
      runId: outcome.runId,
    })
  }
}

/**
 * Watch the chat store for new harness failures. Each diagnostic is handled
 * once (by id), however often the store re-emits it.
 */
export function watchFailedTurns(onFailure: (sessionId: string, d: CogniaDiagnostic) => void) {
  const seen = new Set<string>()
  const scan = (sessions: ReturnType<typeof useChatStore.getState>["sessions"]) => {
    for (const [sessionId, slice] of Object.entries(sessions)) {
      const d = slice.errorDiagnostic
      if (!d || seen.has(d.id) || !isHarnessFailure(d)) continue
      seen.add(d.id)
      onFailure(sessionId, d)
    }
  }
  // Failures already on screen at boot were raised before this process could
  // react to them; only new ones queue runs.
  for (const slice of Object.values(useChatStore.getState().sessions)) {
    if (slice.errorDiagnostic) seen.add(slice.errorDiagnostic.id)
  }
  return useChatStore.subscribe((state, prev) => {
    if (state.sessions !== prev.sessions) scan(state.sessions)
  })
}

export function HarnessEvolutionInitializer() {
  useEffect(() => {
    // Once per process: StrictMode remounts must not install twice.
    if (started) return
    started = true
    let disposed = false
    const disposers: (() => void)[] = []
    // Installers resolve asynchronously; one that lands after unmount is
    // undone at once instead of leaking.
    const keep = (dispose: () => void) => {
      if (disposed) dispose()
      else disposers.push(dispose)
    }
    void import("@/lib/harness/runtime/live-rules")
      .then(({ installLiveToolRules }) => installLiveToolRules())
      .then(keep)
      .catch((error: unknown) =>
        loggers.agent.warn("harness live tool rules failed to install", { error: String(error) })
      )
    void import("@/lib/harness/runtime/run-control")
      .then(async (control) => {
        keep(await control.installHarnessNotificationActions())
        const recovered = await control.recoverOrphanedHarnessRuns()
        if (recovered.length) {
          loggers.agent.info("harness evolution runs interrupted by a restart", { recovered })
        }
      })
      .catch((error: unknown) =>
        loggers.agent.warn("harness evolution boot failed", { error: String(error) })
      )
    keep(
      watchFailedTurns((sessionId, diagnostic) => {
        void handleFailedTurn(sessionId, diagnostic).catch((error: unknown) =>
          loggers.agent.warn("harness evolution could not queue a run for a failure", {
            sessionId,
            error: String(error),
          })
        )
      })
    )
    return () => {
      disposed = true
      for (const dispose of disposers) dispose()
      started = false
    }
  }, [])
  return null
}

/** Test seam. */
export function __resetHarnessEvolutionInitializerForTests() {
  started = false
}

export default HarnessEvolutionInitializer
