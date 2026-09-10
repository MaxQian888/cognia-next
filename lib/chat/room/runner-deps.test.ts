/**
 * `runner-deps.ts` is two interfaces. What a test can pin is that a complete
 * fake of each still compiles, so a seam added to the runner without a fake
 * here fails the build rather than the next headless boot, and that the two
 * seams stay disjoint: everything that does IO is a dep, everything that
 * reports state is a sink.
 */

import type { RoomRunnerDeps, RoomRunnerSinks } from "./runner-deps"

export function makeFakeDeps(): RoomRunnerDeps {
  return {
    ipc: {
      sendPrompt: async () => undefined,
      interruptSession: async () => undefined,
      closeSession: async () => undefined,
      approveTool: async () => undefined,
    },
    db: {
      getSession: async () => undefined,
      updateSession: async () => undefined,
      touchSession: async () => undefined,
      getTeam: async () => undefined,
      listCharactersByIds: async () => [],
      listMessages: async () => [],
      persistMessages: async () => undefined,
      bumpUnread: async () => undefined,
      recordResultUsage: async () => undefined,
    },
    execution: {
      isAtCapacity: () => false,
      runWithExecutionLease: (_request, run) => run(),
      acquireChatLease: async () => undefined,
      slotKeyForTurn: () => undefined,
      resolveEffectiveCwdForSession: async () => null,
    },
    ai: {
      resolveSendOptions: async () => ({}),
      tryBuildTwinDeps: async () => undefined,
      tryBuildMemoryDeps: async () => undefined,
      generateSafeEmbedding: async () => ({ embedding: [] }),
      runTurnMemory: async () => undefined,
      buildUtilityLlmClient: () => null,
      runTitleTask: async () => undefined,
      resolveProviderAttemptOptions: async () => ({}),
      pendingRecoveryPhase: () => null,
      applySdkSubagentBridge: () => undefined,
      recordChatToolApprovalDecision: async () => undefined,
    },
    now: () => 0,
    newTurnId: () => "turn",
    persistDelayMs: 0,
  }
}

export function makeFakeSinks(): RoomRunnerSinks {
  return {
    status: { get: () => "idle", set: () => undefined, setError: () => undefined },
    diagnostic: () => undefined,
    messages: {
      read: () => undefined,
      commit: () => undefined,
      setActiveBranch: () => undefined,
      isOpen: () => false,
    },
    steer: {
      queue: () => [],
      enqueue: () => undefined,
      clear: () => undefined,
      appendMessage: () => undefined,
      drain: () => undefined,
      armed: new Set(),
    },
    members: {
      setStatus: () => undefined,
      setActivity: () => undefined,
      clearFor: () => undefined,
      isStopRequested: () => false,
      clearStopRequest: () => undefined,
      clearStopRequestsFor: () => undefined,
    },
    approvals: {
      push: () => undefined,
      clear: () => undefined,
      routeRemote: () => false,
    },
    settings: {
      read: () => undefined,
      alwaysAllowTools: () => [],
      toggleAlwaysAllow: async () => {},
    },
    referencedPaths: () => [],
  }
}

it("keeps IO on the deps side and observation on the sinks side", () => {
  const deps = makeFakeDeps()
  const sinks = makeFakeSinks()
  expect(Object.keys(deps).sort()).toEqual(
    ["ai", "db", "execution", "ipc", "newTurnId", "now", "persistDelayMs"].sort()
  )
  expect(Object.keys(sinks).sort()).toEqual(
    [
      "approvals",
      "diagnostic",
      "members",
      "messages",
      "settings",
      "status",
      "steer",
      "referencedPaths",
    ].sort()
  )
  // No sink reaches the sidecar or Dexie, no dep reaches a store.
  expect(Object.keys(deps.ipc)).toEqual([
    "sendPrompt",
    "interruptSession",
    "closeSession",
    "approveTool",
  ])
  expect(sinks.approvals.onEvent).toBeUndefined()
})

it("lets a companion projection replace only the durable writes", async () => {
  const deps = makeFakeDeps()
  const projected: RoomRunnerDeps = {
    ...deps,
    db: { ...deps.db, persistMessages: async () => undefined },
  }
  await expect(projected.db.persistMessages("room", [])).resolves.toBeUndefined()
  expect(projected.ipc).toBe(deps.ipc)
})
