import { renderHook } from "@testing-library/react"
import { useActiveSessionLabel } from "./use-active-session-label"

jest.mock("@/lib/db/sessions", () => ({ getSession: jest.fn() }))
jest.mock("@/lib/db/characters", () => ({ getCharacter: jest.fn() }))

const sessionRef = {
  value: undefined as undefined | { id: string; title?: string; characterId?: string },
}
const characterRef = {
  value: undefined as undefined | { id: string; name: string },
}
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (factory: () => unknown) => {
    const src = factory.toString()
    if (src.includes("getCharacter")) return characterRef.value
    return sessionRef.value
  },
}))

const chatRef = { activeSessionId: null as string | null }
jest.mock("@/stores/chat/chat-store", () => ({
  useChatStore: (selector: (s: unknown) => unknown) =>
    selector({ activeSessionId: chatRef.activeSessionId }),
}))

beforeEach(() => {
  sessionRef.value = undefined
  characterRef.value = undefined
  chatRef.activeSessionId = null
})

describe("useActiveSessionLabel", () => {
  it("returns null label when there is no active session", () => {
    const { result } = renderHook(() => useActiveSessionLabel())
    expect(result.current.activeSessionId).toBeNull()
    expect(result.current.session).toBeUndefined()
    expect(result.current.label).toBeNull()
  })

  it("falls back to the session title when there is no character", () => {
    chatRef.activeSessionId = "s-1"
    sessionRef.value = { id: "s-1", title: "Refactor message list" }
    const { result } = renderHook(() => useActiveSessionLabel())
    expect(result.current.label).toBe("Refactor message list")
  })

  it("prefers the character name over the session title", () => {
    chatRef.activeSessionId = "s-1"
    sessionRef.value = { id: "s-1", title: "Some title", characterId: "c-1" }
    characterRef.value = { id: "c-1", name: "Ada" }
    const { result } = renderHook(() => useActiveSessionLabel())
    expect(result.current.label).toBe("Ada")
    expect(result.current.character).toEqual({ id: "c-1", name: "Ada" })
  })

  it("returns null label when the session has no title and no character", () => {
    chatRef.activeSessionId = "s-1"
    sessionRef.value = { id: "s-1" }
    const { result } = renderHook(() => useActiveSessionLabel())
    expect(result.current.label).toBeNull()
  })
})
