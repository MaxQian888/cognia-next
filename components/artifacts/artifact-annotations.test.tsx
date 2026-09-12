/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

const mockQueueAnnotation = jest.fn().mockResolvedValue(undefined)
const mockSendAnnotations = jest.fn().mockResolvedValue(true)
jest.mock("@/hooks/browser/use-selection-to-chat", () => ({
  useSelectionToChat: () => ({
    queueAnnotation: (...args: unknown[]) => mockQueueAnnotation(...args),
    sendAnnotations: (...args: unknown[]) => mockSendAnnotations(...args),
  }),
}))

const mockListActionable = jest.fn()
const mockTransition = jest.fn().mockResolvedValue(true)
jest.mock("@/lib/db/browser-annotations", () => ({
  listActionableAnnotations: (...args: unknown[]) => mockListActionable(...args),
  transitionBrowserAnnotation: (...args: unknown[]) => mockTransition(...args),
}))

let liveRows: unknown[] = []
jest.mock("@/hooks/data/use-client-live-query", () => ({
  useClientLiveQuery: (query: () => Promise<unknown>) => {
    // Record the query so the scoping assertion can inspect what was asked for.
    void query()
    return liveRows
  },
}))

jest.mock("@/components/chat/ui/tooltip-icon-button", () => ({
  TooltipIconButton: ({ children, ...props }: React.ComponentProps<"button">) => {
    const { tooltip: _t, ...rest } = props as { tooltip?: string }
    return <button {...rest}>{children}</button>
  },
}))

import type { ElementSelectionCore } from "@/types/element-selection"

import { ArtifactAnnotations } from "./artifact-annotations"

const picked: ElementSelectionCore = {
  selector: "#card > button",
  domPath: "div.card > button",
  tagName: "button",
  id: null,
  classes: "primary",
  rect: { x: 0, y: 0, width: 10, height: 10 },
  outerHTML: "<button>Go</button>",
  text: "Go",
}

function row(over: Record<string, unknown> = {}) {
  return {
    id: "r1",
    sessionId: "s1",
    target: { kind: "artifact", artifactId: "a1" },
    selection: picked,
    comment: "Increase contrast",
    intent: "change",
    severity: "important",
    status: "pending",
    thread: [],
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  liveRows = []
  mockListActionable.mockResolvedValue([])
})

function renderIt(overrides: Partial<Parameters<typeof ArtifactAnnotations>[0]> = {}) {
  const onQueued = jest.fn()
  render(
    <ArtifactAnnotations
      artifactId="a1"
      sessionId="s1"
      lastPicked={null}
      onQueued={onQueued}
      {...overrides}
    />
  )
  return { onQueued }
}

describe("ArtifactAnnotations", () => {
  it("asks only for THIS artifact's rows", () => {
    // The whole reason the readers take a scope: an unscoped query would hand
    // this panel the embedded browser's queue, and vice versa.
    renderIt()
    expect(mockListActionable).toHaveBeenCalledWith("s1", { kind: "artifact", artifactId: "a1" })
  })

  it("invites a pick when there is nothing to show", () => {
    renderIt()
    expect(screen.getByTestId("artifact-annotations-empty")).toBeInTheDocument()
  })

  it("names the picked element by its component when it has one", () => {
    renderIt({ lastPicked: { ...picked, componentName: "SubmitButton" } })
    expect(screen.getByText("<SubmitButton>")).toBeInTheDocument()
  })

  it("falls back to the selector when there is no component", () => {
    renderIt({ lastPicked: picked })
    expect(screen.getByText("#card > button")).toBeInTheDocument()
  })

  it("will not queue an empty note", () => {
    renderIt({ lastPicked: picked })
    expect(screen.getByTestId("artifact-annotation-add")).toBeDisabled()
  })

  it("queues against the artifact target, with no invented page URL", async () => {
    const { onQueued } = renderIt({ lastPicked: picked })
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "make it blue" } })
    fireEvent.change(screen.getByLabelText("intent.label"), { target: { value: "fix" } })
    fireEvent.change(screen.getByLabelText("severity.label"), { target: { value: "blocking" } })
    fireEvent.click(screen.getByTestId("artifact-annotation-add"))

    await waitFor(() => expect(mockQueueAnnotation).toHaveBeenCalledTimes(1))
    const [selection, comment, options] = mockQueueAnnotation.mock.calls[0]
    expect(selection).toBe(picked)
    expect(comment).toBe("make it blue")
    expect(options).toEqual({
      sessionId: "s1",
      target: { kind: "artifact", artifactId: "a1" },
      intent: "fix",
      severity: "blocking",
    })
    expect(options).not.toHaveProperty("baseUrl")
    await waitFor(() => expect(onQueued).toHaveBeenCalled())
  })

  it("renders the queue through the shared list", () => {
    liveRows = [row(), row({ id: "r2", comment: "Tighten spacing" })]
    renderIt()
    expect(screen.getAllByTestId("annotation-queue-row")).toHaveLength(2)
  })

  it("sends the pending batch text-only — an artifact has no webview to capture", async () => {
    liveRows = [row(), row({ id: "r2", status: "acknowledged" })]
    renderIt()
    fireEvent.click(screen.getByTestId("annotation-queue-send"))

    await waitFor(() => expect(mockSendAnnotations).toHaveBeenCalledTimes(1))
    const [rows, options] = mockSendAnnotations.mock.calls[0]
    expect(rows.map((r: { id: string }) => r.id)).toEqual(["r1"])
    expect(options).toEqual({ sessionId: "s1", includeScreenshot: false })
  })

  it("records a human outcome when a row is resolved", async () => {
    liveRows = [row()]
    renderIt()
    fireEvent.click(screen.getByLabelText("resolve"))
    await waitFor(() => expect(mockTransition).toHaveBeenCalledTimes(1))
    expect(mockTransition.mock.calls[0][1]).toBe("resolved")
    expect(mockTransition.mock.calls[0][3]).toBe("human")
  })

  it("does not query at all without a conversation", () => {
    renderIt({ sessionId: null })
    expect(mockListActionable).not.toHaveBeenCalled()
  })
})
