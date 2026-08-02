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
