/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, act, within } from "@testing-library/react"

// ---- Module mocks ----

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const routerBackMock = jest.fn()
const routerReplaceMock = jest.fn()
let mockParams = new URLSearchParams("")
jest.mock("next/navigation", () => ({
  useRouter: () => ({
    back: routerBackMock,
    replace: routerReplaceMock,
  }),
  useSearchParams: () => mockParams,
}))

let mockSessions: Array<{ id: string; title?: string | null }> = []
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => mockSessions,
}))

const listSessionsMock = jest.fn(async () => mockSessions)
jest.mock("@/lib/db/sessions", () => ({
  listSessions: () => listSessionsMock(),
}))

const enqueueMock: jest.Mock = jest.fn(async () => undefined)
jest.mock("@/lib/db/mobile-outbound-queue", () => ({
  enqueue: (arg: unknown) => enqueueMock(arg),
}))

const toastSuccessMock: jest.Mock = jest.fn()
jest.mock("sonner", () => ({
  toast: { success: (arg: unknown) => toastSuccessMock(arg) },
}))

let mockKeyboard: { keyboardHeight: number; isVisible: boolean } = {
  keyboardHeight: 0,
  isVisible: false,
}
jest.mock("@/hooks/ui/use-keyboard-insets", () => ({
  useKeyboardInsets: () => mockKeyboard,
}))

import ShareTargetPage from "./page"

beforeEach(() => {
  routerBackMock.mockClear()
  routerReplaceMock.mockClear()
  enqueueMock.mockClear()
  toastSuccessMock.mockClear()
  mockSessions = []
  mockParams = new URLSearchParams("")
  mockKeyboard = { keyboardHeight: 0, isVisible: false }
})

function setParams(query: string) {
  mockParams = new URLSearchParams(query)
}

describe("ShareTargetPage", () => {
  it("renders the header and intro when params present", () => {
    setParams("text=hello")
    mockSessions = [{ id: "s1", title: "Alpha" }]
    render(<ShareTargetPage />)
    expect(screen.getByText("title")).toBeInTheDocument()
    expect(screen.getByText("intro")).toBeInTheDocument()
  })

  it("renders the preview Card with received text", () => {
    setParams("text=hello%20world")
    mockSessions = [{ id: "s1", title: "Alpha" }]
    render(<ShareTargetPage />)
    const preview = screen.getByTestId("share-target-preview")
    expect(within(preview).getByText("hello world")).toBeInTheDocument()
  })

  it("renders a safe anchor when url param is present", () => {
    setParams("url=https%3A%2F%2Fexample.com%2Fpath")
    mockSessions = [{ id: "s1", title: "Alpha" }]
    render(<ShareTargetPage />)
    const link = screen.getByRole("link", { name: /example\.com/i }) as HTMLAnchorElement
    expect(link.href).toBe("https://example.com/path")
    expect(link.getAttribute("rel")).toBe("noopener noreferrer")
  })

  it("filters sessions by the search input", () => {
    setParams("text=hello")
    mockSessions = [
      { id: "s1", title: "Alpha chat" },
      { id: "s2", title: "Beta talk" },
    ]
    render(<ShareTargetPage />)
    expect(screen.getByText("Alpha chat")).toBeInTheDocument()
    expect(screen.getByText("Beta talk")).toBeInTheDocument()

    fireEvent.change(screen.getByTestId("share-target-search"), {
      target: { value: "alp" },
    })
    expect(screen.getByText("Alpha chat")).toBeInTheDocument()
    expect(screen.queryByText("Beta talk")).not.toBeInTheDocument()
  })

  it("falls back to the session id when title is missing", () => {
    setParams("text=hello")
    mockSessions = [{ id: "s-no-title", title: null }]
    render(<ShareTargetPage />)
    expect(screen.getByText("s-no-title")).toBeInTheDocument()
  })

  it("enqueues a connector_send job and shows a toast on pick", async () => {
    setParams("text=hello&url=https%3A%2F%2Fa.example")
    mockSessions = [{ id: "s1", title: "Alpha" }]
    render(<ShareTargetPage />)

    await act(async () => {
      fireEvent.click(screen.getByTestId("share-target-pick-s1"))
    })

    expect(enqueueMock).toHaveBeenCalledTimes(1)
    const arg = (enqueueMock.mock.calls[0] as unknown[])[0] as {
      command: string
      payload: { sessionId: string; segments: Array<{ type: string; text: string }> }
      label: string
    }
    expect(arg.command).toBe("connector_send")
    expect(arg.payload.sessionId).toBe("s1")
    expect(arg.payload.segments[0]!.type).toBe("text")
    expect(arg.payload.segments[0]!.text).toBe("hello\nhttps://a.example")
    expect(arg.label).toBe("Share → Alpha")
    expect(toastSuccessMock).toHaveBeenCalledWith("queuedToast")
    expect(routerReplaceMock).toHaveBeenCalledWith("/")
  })

  it("uses the session id in the label when title is missing", async () => {
    setParams("text=hi")
    mockSessions = [{ id: "s-x", title: null }]
    render(<ShareTargetPage />)

    await act(async () => {
      fireEvent.click(screen.getByTestId("share-target-pick-s-x"))
    })

    const arg = (enqueueMock.mock.calls[0] as unknown[])[0] as { label: string }
    expect(arg.label).toBe("Share → s-x")
  })

  it("ignores a second click while the first enqueue is pending (busy guard)", async () => {
    setParams("text=hello")
    mockSessions = [{ id: "s1", title: "Alpha" }]
    // Make enqueue resolve only when we release it.
    let release: () => void = () => {}
    const blocker = new Promise<void>((resolve) => {
      release = resolve
    })
    enqueueMock.mockImplementationOnce(async () => {
      await blocker
    })
    render(<ShareTargetPage />)
    const btn = screen.getByTestId("share-target-pick-s1")
    await act(async () => {
      fireEvent.click(btn)
    })
    await act(async () => {
      fireEvent.click(btn)
    })
    expect(enqueueMock).toHaveBeenCalledTimes(1)
    await act(async () => {
      release()
      await Promise.resolve()
    })
  })

  it("renders the Empty block when no sessions are available", () => {
    setParams("text=hello")
    mockSessions = []
    render(<ShareTargetPage />)
    expect(screen.getByTestId("share-target-empty")).toBeInTheDocument()
    expect(screen.getByText("noConversations")).toBeInTheDocument()
    expect(screen.getByText("noConversationsDescription")).toBeInTheDocument()
  })

  it("auto-redirects to / when neither text nor url params are present", () => {
    jest.useFakeTimers()
    try {
      setParams("")
      mockSessions = []
      render(<ShareTargetPage />)
      expect(routerReplaceMock).not.toHaveBeenCalled()
      act(() => {
        jest.advanceTimersByTime(800)
      })
      expect(routerReplaceMock).toHaveBeenCalledWith("/")
    } finally {
      jest.useRealTimers()
    }
  })

  it("cancels the auto-redirect timer on unmount", () => {
    jest.useFakeTimers()
    try {
      setParams("")
      const { unmount } = render(<ShareTargetPage />)
      unmount()
      act(() => {
        jest.advanceTimersByTime(2000)
      })
      expect(routerReplaceMock).not.toHaveBeenCalled()
    } finally {
      jest.useRealTimers()
    }
  })

  it("invokes router.back when the back button is clicked", () => {
    setParams("text=hello")
    render(<ShareTargetPage />)
    fireEvent.click(screen.getByTestId("share-target-back"))
    expect(routerBackMock).toHaveBeenCalled()
  })

  it("applies the keyboard inset padding when the soft keyboard is open", () => {
    setParams("text=hello")
    mockKeyboard = { keyboardHeight: 240, isVisible: true }
    render(<ShareTargetPage />)
    const main = screen.getByTestId("share-target-page")
    expect(main.style.paddingBottom).toBe("256px")
  })

  it("uses an undefined padding when the keyboard is hidden", () => {
    setParams("text=hello")
    mockKeyboard = { keyboardHeight: 0, isVisible: false }
    render(<ShareTargetPage />)
    const main = screen.getByTestId("share-target-page")
    expect(main.style.paddingBottom).toBe("")
  })

  it("disables session buttons when body is empty (e.g., neither text nor url)", () => {
    // Body is empty when both text and url are absent, but the page would
    // auto-redirect — to verify the disabled branch deterministically we
    // freeze the redirect by using fake timers.
    jest.useFakeTimers()
    try {
      setParams("")
      mockSessions = [{ id: "s1", title: "Alpha" }]
      render(<ShareTargetPage />)
      const btn = screen.getByTestId("share-target-pick-s1") as HTMLButtonElement
      expect(btn.disabled).toBe(true)
    } finally {
      jest.useRealTimers()
    }
  })
})
