import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"

import { TooltipProvider } from "@/components/ui/tooltip"
import messages from "@/i18n/messages/en.json"
import type { BrowserSelection } from "@/lib/browser/protocol"
import type { BrowserAnnotationRow } from "@/lib/db/browser-annotations"

const mockSendComment = jest.fn()
const mockQueueAnnotation = jest.fn()
const mockSendAnnotations = jest.fn()
const mockTransition = jest.fn()
let mockQueue: BrowserAnnotationRow[] = []

jest.mock("sonner", () => ({ toast: { error: jest.fn(), success: jest.fn() } }))
jest.mock("@/hooks/browser/use-selection-to-chat", () => ({
  useSelectionToChat: () => ({
    sendComment: mockSendComment,
    queueAnnotation: mockQueueAnnotation,
    sendAnnotations: mockSendAnnotations,
  }),
}))
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (factory: () => unknown) => {
    void factory()
    return mockQueue
  },
}))
jest.mock("@/lib/db/browser-annotations", () => ({
  deleteExpiredBrowserAnnotations: jest.fn().mockResolvedValue(0),
  listActionableBrowserAnnotations: jest.fn().mockResolvedValue([]),
  transitionBrowserAnnotation: (...args: unknown[]) => mockTransition(...args),
}))
jest.mock("@/components/browser/browser-adjust-controls", () => ({
  BrowserAdjustControls: (props: {
    driver?: unknown
    pageUrl: string
    onAccept(feedback: unknown): void
  }) => (
    <button
      type="button"
      data-testid="adjust-controls"
      data-driver={props.driver ? "custom" : "embedded"}
      onClick={() =>
        props.onAccept({ id: "adj", pageUrl: props.pageUrl, changes: [], previewState: "accepted" })
      }
    >
      adjust
    </button>
  ),
}))

import { listActionableBrowserAnnotations } from "@/lib/db/browser-annotations"
import { BrowserInspectionRail, type BrowserInspectionRailProps } from "./browser-inspection-rail"

const pick = (selector: string): BrowserSelection => ({
  paneId: "local:p1",
  selector,
  domPath: `body > ${selector}`,
  tagName: "BUTTON",
  id: null,
  classes: null,
  rect: { x: 0, y: 0, width: 10, height: 10 },
  outerHTML: "<button></button>",
  text: "Go",
  pageUrl: "https://example.com/page",
  pageTitle: "Example",
})

function renderRail(overrides: Partial<BrowserInspectionRailProps> = {}) {
  const props: BrowserInspectionRailProps = {
    selection: pick("#b"),
    selections: [pick("#a"), pick("#b")],
    onClearSelection: jest.fn(),
    pageUrl: "https://example.com/page",
    sessionId: "chat-1",
    browserSessionId: "browser:chat-1",
    capture: jest.fn(() => ({ capture: async () => ({ bytes: "AAAA" }) })),
    detailLevel: "standard",
    placement: "side",
    ...overrides,
  }
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <TooltipProvider>
        <BrowserInspectionRail {...props} />
      </TooltipProvider>
    </NextIntlClientProvider>
  )
  return props
}

beforeEach(() => {
  mockQueue = []
  mockSendComment.mockReset().mockResolvedValue(true)
  mockQueueAnnotation.mockReset().mockImplementation(async (target: BrowserSelection) => ({
    id: target.selector,
  }))
  mockSendAnnotations.mockReset().mockResolvedValue(true)
  mockTransition.mockReset().mockResolvedValue(true)
  ;(listActionableBrowserAnnotations as jest.Mock).mockClear()
})

it("stays out of the way with no pick and nothing queued", () => {
  renderRail({ selection: null, selections: [] })
  expect(screen.queryByTestId("browser-inspection-rail")).toBeNull()
})

it("sends every target with the pane's own screenshot, then clears the pick", async () => {
  const props = renderRail()
  expect(screen.getByTestId("browser-inspection-rail")).toHaveAttribute("data-state", "open")
  expect(screen.getByText("#b")).toBeInTheDocument()
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "make it blue" } })
  fireEvent.click(screen.getByRole("button", { name: /send/i }))
  await waitFor(() => expect(props.onClearSelection).toHaveBeenCalled())
  const [targets, text, options] = mockSendComment.mock.calls[0]
  expect(targets).toHaveLength(2)
  expect(text).toBe("make it blue")
  expect(options).toMatchObject({ sessionId: "chat-1", detailLevel: "standard" })
  expect(typeof options.capture).toBe("function")
  expect(props.capture).toHaveBeenCalledTimes(1)
})

it("queues one annotation per target on the page's origin, with Adjust feedback", async () => {
  const props = renderRail({ adjustDriver: { run: jest.fn() } })
  expect(screen.getByTestId("adjust-controls")).toHaveAttribute("data-driver", "custom")
  fireEvent.click(screen.getByTestId("adjust-controls"))
  expect(screen.getByText(messages.browser.adjust.accepted)).toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: messages.annotations.add }))
  await waitFor(() => expect(mockQueueAnnotation).toHaveBeenCalledTimes(2))
  const [, text, options] = mockQueueAnnotation.mock.calls[0]
  expect(text).toContain("<browser_adjustment_feedback>")
  expect(options).toMatchObject({
    sessionId: "chat-1",
    baseUrl: "https://example.com",
    intent: "change",
    severity: "suggestion",
  })
  await waitFor(() => expect(props.onClearSelection).toHaveBeenCalled())
})

it("cancels with Escape and keeps Send disabled until there is something to say", async () => {
  const user = userEvent.setup()
  const props = renderRail()
  expect(screen.getByRole("button", { name: /send/i })).toBeDisabled()
  await user.click(screen.getByRole("textbox"))
  await user.keyboard("{Escape}")
  expect(props.onClearSelection).toHaveBeenCalled()
})

it("sends the session's queue with the same screenshot source", async () => {
  mockQueue = [
    {
      id: "a1",
      sessionId: "chat-1",
      baseUrl: "https://example.com",
      selection: pick("#a"),
      comment: "fix",
      intent: "fix",
      severity: "important",
      status: "pending",
      thread: [],
      createdAt: 1,
      updatedAt: 1,
    },
  ]
  const props = renderRail({ selection: null, selections: [] })
  expect(listActionableBrowserAnnotations).toHaveBeenCalledWith("chat-1")
  fireEvent.click(screen.getByRole("button", { name: /send/i }))
  await waitFor(() => expect(mockSendAnnotations).toHaveBeenCalled())
  expect(mockSendAnnotations.mock.calls[0][1]).toMatchObject({ sessionId: "chat-1" })
  expect(props.capture).toHaveBeenCalled()
})
