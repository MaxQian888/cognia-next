import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"
import { TriggerBadge } from "./trigger-badge"
import { clearAllTriggerAudit, recordTriggerAuditEntry } from "@/lib/chat/trigger-audit-ring"

function renderBadge(props: { sessionId: string; messageId: string }) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <TriggerBadge {...props} />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  clearAllTriggerAudit()
})

afterEach(() => {
  clearAllTriggerAudit()
})

describe("TriggerBadge", () => {
  it("renders nothing when no triggers fired for the message", () => {
    const { container } = renderBadge({ sessionId: "s1", messageId: "m1" })
    expect(container.firstChild).toBeNull()
  })

  it("renders a count badge when triggers exist", () => {
    act(() => {
      recordTriggerAuditEntry({
        sessionId: "s1",
        messageId: "m1",
        kind: "trigger.chat.message",
        pluginId: null,
        workflowId: "wf-a",
        status: "dispatched",
      })
      recordTriggerAuditEntry({
        sessionId: "s1",
        messageId: "m1",
        kind: "trigger.chat.message",
        pluginId: null,
        workflowId: "wf-b",
        status: "dispatched",
      })
    })
    renderBadge({ sessionId: "s1", messageId: "m1" })
    expect(screen.getByTestId("trigger-badge")).toBeInTheDocument()
    expect(screen.getByText("2 workflow triggers")).toBeInTheDocument()
  })

  it("popover lists every workflow + status for the message", async () => {
    const user = userEvent.setup()
    act(() => {
      recordTriggerAuditEntry({
        sessionId: "s1",
        messageId: "m1",
        kind: "trigger.chat.message",
        pluginId: null,
        workflowId: "wf-ok",
        status: "dispatched",
      })
      recordTriggerAuditEntry({
        sessionId: "s1",
        messageId: "m1",
        kind: "trigger.foo.bar",
        pluginId: "foo",
        workflowId: "wf-bad",
        status: "error",
        errorMessage: "boom",
      })
    })
    renderBadge({ sessionId: "s1", messageId: "m1" })
    await user.click(screen.getByTestId("trigger-badge"))
    expect(await screen.findByText("Workflow triggers")).toBeInTheDocument()
    expect(screen.getByText("trigger.chat.message")).toBeInTheDocument()
    expect(screen.getByText("trigger.foo.bar")).toBeInTheDocument()
    expect(screen.getByText("Dispatched")).toBeInTheDocument()
    expect(screen.getByText("Error")).toBeInTheDocument()
    expect(screen.getByText("boom")).toBeInTheDocument()
  })

  it("ignores triggers from other messages in the same session", () => {
    act(() => {
      recordTriggerAuditEntry({
        sessionId: "s1",
        messageId: "m1",
        kind: "trigger.chat.message",
        pluginId: null,
        workflowId: "wf",
        status: "dispatched",
      })
    })
    const { container } = renderBadge({ sessionId: "s1", messageId: "m-other" })
    expect(container.firstChild).toBeNull()
  })

  it("re-renders when a new entry is recorded after mount", () => {
    const { container } = renderBadge({ sessionId: "s1", messageId: "m1" })
    expect(container.firstChild).toBeNull()
    act(() => {
      recordTriggerAuditEntry({
        sessionId: "s1",
        messageId: "m1",
        kind: "trigger.chat.message",
        pluginId: null,
        workflowId: "wf",
        status: "dispatched",
      })
    })
    expect(screen.getByTestId("trigger-badge")).toBeInTheDocument()
  })
})
