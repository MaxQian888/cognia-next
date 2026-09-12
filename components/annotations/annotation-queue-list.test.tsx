/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

jest.mock("@/components/chat/ui/tooltip-icon-button", () => ({
  TooltipIconButton: ({
    children,
    ...props
  }: React.ComponentProps<"button"> & { tooltip?: string }) => {
    const { tooltip: _tooltip, ...rest } = props as { tooltip?: string }
    return <button {...rest}>{children}</button>
  },
}))

import type { BrowserAnnotationRow } from "@/lib/db/browser-annotations"

import { AnnotationQueueList } from "./annotation-queue-list"

function row(over: Partial<BrowserAnnotationRow> = {}): BrowserAnnotationRow {
  return {
    id: "r1",
    sessionId: "s1",
    baseUrl: "https://example.test",
    selection: {
      selector: "#a",
      domPath: "div > a",
      tagName: "a",
      id: null,
      classes: null,
      rect: { x: 0, y: 0, width: 1, height: 1 },
      outerHTML: "<a></a>",
      text: "",
    },
    comment: "Increase contrast",
    intent: "change",
    severity: "important",
    status: "pending",
    thread: [],
    createdAt: 1,
    updatedAt: 1,
    ...over,
  } as BrowserAnnotationRow
}

describe("AnnotationQueueList", () => {
  it("renders nothing at all when the queue is empty", () => {
    // An empty container would still take vertical space in a narrow dock.
    const { container } = render(
      <AnnotationQueueList
        annotations={[]}
        pendingCount={0}
        onSend={jest.fn()}
        onTransition={jest.fn()}
      />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it("lists each annotation with its outcome and classification", () => {
    render(
      <AnnotationQueueList
        annotations={[row(), row({ id: "r2", comment: "Tighten spacing", status: "acknowledged" })]}
        pendingCount={1}
        onSend={jest.fn()}
        onTransition={jest.fn()}
      />
    )
    expect(screen.getAllByTestId("annotation-queue-row")).toHaveLength(2)
    expect(screen.getByText("1. Increase contrast")).toBeInTheDocument()
    expect(screen.getByText("2. Tighten spacing")).toBeInTheDocument()
    expect(screen.getByText("status.pending")).toBeInTheDocument()
    expect(screen.getByText("status.acknowledged")).toBeInTheDocument()
  })

  it("counts the queue but sends only what is still pending", () => {
    render(
      <AnnotationQueueList
        annotations={[row(), row({ id: "r2", status: "acknowledged" })]}
        pendingCount={1}
        onSend={jest.fn()}
        onTransition={jest.fn()}
      />
    )
    expect(screen.getByText('queued:{"count":2}')).toBeInTheDocument()
    expect(screen.getByTestId("annotation-queue-send")).toHaveTextContent('send:{"count":1}')
  })

  it("refuses to send when nothing is pending", () => {
    render(
      <AnnotationQueueList
        annotations={[row({ status: "acknowledged" })]}
        pendingCount={0}
        onSend={jest.fn()}
        onTransition={jest.fn()}
      />
    )
    expect(screen.getByTestId("annotation-queue-send")).toBeDisabled()
  })

  it("does not let a send be double-fired", () => {
    render(
      <AnnotationQueueList
        annotations={[row()]}
        pendingCount={1}
        onSend={jest.fn()}
        onTransition={jest.fn()}
        busy
      />
    )
    expect(screen.getByTestId("annotation-queue-send")).toBeDisabled()
  })

  it("reports resolve and dismiss against the right row", () => {
    const onTransition = jest.fn()
    render(
      <AnnotationQueueList
        annotations={[row({ id: "keep" }), row({ id: "drop" })]}
        pendingCount={2}
        onSend={jest.fn()}
        onTransition={onTransition}
      />
    )
    const rows = screen.getAllByTestId("annotation-queue-row")
    fireEvent.click(rows[0].querySelector('[aria-label="resolve"]')!)
    fireEvent.click(rows[1].querySelector('[aria-label="remove"]')!)

    expect(onTransition).toHaveBeenNthCalledWith(1, "keep", "resolved")
    expect(onTransition).toHaveBeenNthCalledWith(2, "drop", "dismissed")
  })

  it("sends on demand", () => {
    const onSend = jest.fn()
    render(
      <AnnotationQueueList
        annotations={[row()]}
        pendingCount={1}
        onSend={onSend}
        onTransition={jest.fn()}
      />
    )
    fireEvent.click(screen.getByTestId("annotation-queue-send"))
    expect(onSend).toHaveBeenCalledTimes(1)
  })
})
