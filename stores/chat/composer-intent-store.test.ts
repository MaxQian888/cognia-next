import { useComposerIntentStore } from "./composer-intent-store"

beforeEach(() => {
  useComposerIntentStore.setState({ pendingBySession: {} })
})

it("stages and consumes one intent per session", () => {
  const intent = { candidateId: "candidate-1", prompt: "Explain this" }

  useComposerIntentStore.getState().stage("session-1", intent)
  expect(useComposerIntentStore.getState().pendingBySession["session-1"]).toEqual(intent)

  expect(useComposerIntentStore.getState().consume("session-1", "candidate-1")).toEqual(intent)
  expect(useComposerIntentStore.getState().pendingBySession["session-1"]).toBeUndefined()
})

it("carries the auto-send flag through stage and consume", () => {
  // The tray quick panel's delegate action sets it; the selection toolbar
  // never does, and its intents must keep arriving without one.
  const auto = { candidateId: "tray-req-1", prompt: "Fix the build", autoSend: true }
  useComposerIntentStore.getState().stage("session-1", auto)
  expect(useComposerIntentStore.getState().consume("session-1", "tray-req-1")).toEqual(auto)

  useComposerIntentStore.getState().stage("session-2", { candidateId: "c", prompt: "Explain" })
  expect(useComposerIntentStore.getState().consume("session-2", "c")?.autoSend).toBeUndefined()
})

it("does not consume a newer intent with a stale candidate id", () => {
  useComposerIntentStore
    .getState()
    .stage("session-1", { candidateId: "candidate-new", prompt: null })

  expect(useComposerIntentStore.getState().consume("session-1", "candidate-old")).toBeNull()
  expect(useComposerIntentStore.getState().pendingBySession["session-1"]).toBeDefined()
})

it("claims one-time UI effects separately by session and effect kind", () => {
  useComposerIntentStore.setState({ claimedEffects: {} })
  const store = useComposerIntentStore.getState()
  expect(store.claimEffect("a:editor", "one")).toBe(true)
  expect(store.claimEffect("a:editor", "one")).toBe(false)
  expect(store.claimEffect("b:editor", "one")).toBe(true)
  for (let i = 0; i < 100; i++) store.claimEffect("a:notification", String(i))
  expect(store.claimEffect("a:editor", "one")).toBe(false)
  expect(useComposerIntentStore.getState().claimedEffects["a:notification"]).toHaveLength(64)
})

it("does not lose restored queue input when an extension replaces the editor in the same tick", () => {
  useComposerIntentStore.setState({ pendingBySession: {} })
  const store = useComposerIntentStore.getState()
  const externalSession = { agentId: "a", sessionId: "native" }
  store.stage("local", {
    candidateId: "queue",
    prompt: "queued",
    mode: "append",
    externalSession,
    images: [{ data: "YQ==", mimeType: "image/png" }],
  })
  store.stage("local", {
    candidateId: "editor",
    prompt: "new draft",
    mode: "replace",
    externalSession,
  })
  expect(useComposerIntentStore.getState().pendingBySession.local).toMatchObject({
    prompt: "new draft\n\nqueued",
    mode: "replace",
    images: [{ data: "YQ==", mimeType: "image/png" }],
  })
})
