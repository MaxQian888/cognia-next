/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, act, within } from "@testing-library/react"

// ---- Module mocks ----

jest.mock("next-intl", () => ({
  // Tests below assert on resolved strings (e.g. "Share from example.com")
  // produced by next-intl interpolation. Keep the mock dumb (returns the
  // key path) but resolve a couple of known templates so the params test
  // can verify the hostname substitution path is reached.
  useTranslations: () => (key: string, params?: Record<string, unknown>) => {
    if (key === "derivedTitle.fromUrl" && params && typeof params.hostname === "string") {
      return `Share from ${params.hostname as string}`
    }
    return key
  },
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
const createSessionMock = jest.fn(async (partial?: { title?: string }) => ({
  id: "new-session-id",
  title: partial?.title ?? "New chat",
  createdAt: 0,
  updatedAt: 0,
  kind: "direct" as const,
}))
jest.mock("@/lib/db/sessions", () => ({
  listSessions: () => listSessionsMock(),
  createSession: (partial?: unknown) => createSessionMock(partial as never),
}))

const setDraftMock: jest.Mock = jest.fn(async () => undefined)
jest.mock("@/lib/db/chat-drafts", () => ({
  setDraft: (sessionId: string, text: string) => setDraftMock(sessionId, text),
}))

const enqueueMock: jest.Mock = jest.fn(async () => undefined)
jest.mock("@/lib/db/mobile-outbound-queue", () => ({
  enqueue: (arg: unknown) => enqueueMock(arg),
}))

const toastSuccessMock: jest.Mock = jest.fn()
const toastErrorMock: jest.Mock = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (arg: unknown) => toastSuccessMock(arg),
    error: (arg: unknown) => toastErrorMock(arg),
  },
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
  createSessionMock.mockClear()
  setDraftMock.mockClear()
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

  // ── New session / Inbox draft ──────────────────────────────────────────

  it("renders the new-session and inbox-draft target buttons", () => {
    setParams("text=hello")
    mockSessions = [{ id: "s1", title: "Alpha" }]
    render(<ShareTargetPage />)
    expect(screen.getByTestId("share-target-new-session")).toBeInTheDocument()
    expect(screen.getByTestId("share-target-inbox-draft")).toBeInTheDocument()
  })

  it("disables both quick-action buttons when there is no body", () => {
    setParams("")
    mockSessions = [{ id: "s1", title: "Alpha" }]
    render(<ShareTargetPage />)
    const newBtn = screen.getByTestId("share-target-new-session") as HTMLButtonElement
    const draftBtn = screen.getByTestId("share-target-inbox-draft") as HTMLButtonElement
    expect(newBtn.disabled).toBe(true)
    expect(draftBtn.disabled).toBe(true)
  })

  it("creates a new session and enqueues a send when 'New session' is picked", async () => {
    setParams("text=hello%20there&url=https%3A%2F%2Fa.example")
    mockSessions = [{ id: "s1", title: "Alpha" }]
    render(<ShareTargetPage />)
    await act(async () => {
      fireEvent.click(screen.getByTestId("share-target-new-session"))
    })
    expect(createSessionMock).toHaveBeenCalledTimes(1)
    expect(enqueueMock).toHaveBeenCalledTimes(1)
    const arg = (enqueueMock.mock.calls[0] as unknown[])[0] as {
      payload: { sessionId: string; segments: Array<{ text: string }> }
    }
    expect(arg.payload.sessionId).toBe("new-session-id")
    expect(arg.payload.segments[0]!.text).toBe("hello there\nhttps://a.example")
    expect(routerReplaceMock).toHaveBeenCalledWith("/?session=new-session-id")
  })

  it("derives a title from the first line of text", async () => {
    setParams("text=" + encodeURIComponent("First line\nSecond line continues here"))
    mockSessions = []
    render(<ShareTargetPage />)
    await act(async () => {
      fireEvent.click(screen.getByTestId("share-target-new-session"))
    })
    const arg = createSessionMock.mock.calls[0]?.[0] as { title: string }
    expect(arg.title).toBe("First line")
  })

  it("falls back to hostname-based title when only url is shared", async () => {
    setParams("url=https%3A%2F%2Fexample.com%2Fdocs")
    mockSessions = []
    render(<ShareTargetPage />)
    await act(async () => {
      fireEvent.click(screen.getByTestId("share-target-new-session"))
    })
    const arg = createSessionMock.mock.calls[0]?.[0] as { title: string }
    expect(arg.title).toBe("Share from example.com")
  })

  it("saves a chat draft and skips enqueue for 'Inbox draft'", async () => {
    setParams("text=hello%20world")
    mockSessions = []
    render(<ShareTargetPage />)
    await act(async () => {
      fireEvent.click(screen.getByTestId("share-target-inbox-draft"))
    })
    expect(createSessionMock).toHaveBeenCalledTimes(1)
    expect(setDraftMock).toHaveBeenCalledWith("new-session-id", "hello world")
    expect(enqueueMock).not.toHaveBeenCalled()
    expect(toastSuccessMock).toHaveBeenCalledWith("draftSavedToast")
  })

  it("surfaces createSession failure as a toast.error", async () => {
    setParams("text=hello")
    mockSessions = []
    createSessionMock.mockRejectedValueOnce(new Error("dexie locked"))
    render(<ShareTargetPage />)
    await act(async () => {
      fireEvent.click(screen.getByTestId("share-target-new-session"))
    })
    expect(toastErrorMock).toHaveBeenCalledWith("createSessionFailed")
  })
})
