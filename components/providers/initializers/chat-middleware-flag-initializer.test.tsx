import { render } from "@testing-library/react"
import { ChatMiddlewareFlagInitializer } from "./chat-middleware-flag-initializer"
import { useSettingsStore } from "@/stores/settings"
import {
  isChatMiddlewareExecutionEnabled,
  __resetChatMiddlewareFlagForTesting,
} from "@/lib/claude/chat-middleware/feature-flag"

jest.mock("@/stores/settings", () => {
  let state: { settings: unknown } = { settings: undefined }
  const subscribers = new Set<(s: typeof state) => void>()
  return {
    useSettingsStore: {
      getState: () => state,
      subscribe: (fn: (s: typeof state) => void) => {
        subscribers.add(fn)
        return () => subscribers.delete(fn)
      },
      __set: (settings: unknown) => {
        state = { settings }
        subscribers.forEach((fn) => fn(state))
      },
    },
  }
})

const store = useSettingsStore as unknown as { __set: (s: unknown) => void }

beforeEach(() => {
  __resetChatMiddlewareFlagForTesting()
  store.__set(undefined)
})

describe("ChatMiddlewareFlagInitializer", () => {
  it("leaves the flag off when the setting is absent", () => {
    render(<ChatMiddlewareFlagInitializer />)
    expect(isChatMiddlewareExecutionEnabled()).toBe(false)
  })

  it("enables the flag from the current settings snapshot on mount", () => {
    store.__set({ developer: { chatMiddlewareExecution: true } })
    render(<ChatMiddlewareFlagInitializer />)
    expect(isChatMiddlewareExecutionEnabled()).toBe(true)
  })

  it("tracks later settings changes", () => {
    render(<ChatMiddlewareFlagInitializer />)
    expect(isChatMiddlewareExecutionEnabled()).toBe(false)

    store.__set({ developer: { chatMiddlewareExecution: true } })
    expect(isChatMiddlewareExecutionEnabled()).toBe(true)

    store.__set({ developer: { chatMiddlewareExecution: false } })
    expect(isChatMiddlewareExecutionEnabled()).toBe(false)
  })

  it("renders nothing", () => {
    const { container } = render(<ChatMiddlewareFlagInitializer />)
    expect(container.firstChild).toBeNull()
  })
})
