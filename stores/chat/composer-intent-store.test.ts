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

it("does not consume a newer intent with a stale candidate id", () => {
  useComposerIntentStore
    .getState()
    .stage("session-1", { candidateId: "candidate-new", prompt: null })

  expect(useComposerIntentStore.getState().consume("session-1", "candidate-old")).toBeNull()
  expect(useComposerIntentStore.getState().pendingBySession["session-1"]).toBeDefined()
})
