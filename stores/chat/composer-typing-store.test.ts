import {
  clearComposerTyping,
  lastTypedAt,
  noteComposerTyping,
  useComposerTypingStore,
} from "./composer-typing-store"

beforeEach(() => {
  useComposerTypingStore.setState({ typedAt: {} })
})

it("records the last keystroke per session and clears it on send", () => {
  expect(lastTypedAt("s1")).toBeNull()
  noteComposerTyping("s1", 100)
  noteComposerTyping("s2", 200)
  noteComposerTyping("s1", 150)
  expect(lastTypedAt("s1")).toBe(150)
  expect(lastTypedAt("s2")).toBe(200)
  clearComposerTyping("s1")
  expect(lastTypedAt("s1")).toBeNull()
  expect(lastTypedAt("s2")).toBe(200)
})

it("defaults the keystroke time to now and skips a write that changes nothing", () => {
  const before = Date.now()
  noteComposerTyping("s1")
  expect(lastTypedAt("s1")).toBeGreaterThanOrEqual(before)
  const state = useComposerTypingStore.getState()
  state.noteTyping("s1", lastTypedAt("s1"))
  expect(useComposerTypingStore.getState().typedAt).toBe(state.typedAt)
  state.noteTyping("missing", null)
  expect(useComposerTypingStore.getState().typedAt).toBe(state.typedAt)
})
