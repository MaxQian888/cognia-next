/**
 * @jest-environment jsdom
 */

const listAllTriggerAuditEntries = jest.fn()
const clearAllTriggerAudit = jest.fn()
jest.mock("@/lib/chat/trigger-audit-ring", () => ({
  listAllTriggerAuditEntries: () => listAllTriggerAuditEntries(),
  clearAllTriggerAudit: () => clearAllTriggerAudit(),
  subscribeTriggerAuditChanges: () => () => {},
  getTriggerAuditRevision: () => 0,
}))

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"
import type { TriggerAuditEntry } from "@/lib/chat/trigger-audit-ring"

import {
  ALL_TRIGGER_FILTER,
  BUILTIN_TRIGGER_FILTER,
  TriggersPane,
  filterTriggerAuditEntries,
} from "./triggers-pane"

function entry(overrides: Partial<TriggerAuditEntry> = {}): TriggerAuditEntry {
  return {
    id: "audit-1",
    sessionId: "session-1",
    messageId: null,
    kind: "trigger.chat.message",
    pluginId: "demo.plugin",
    workflowId: "wf-1",
    status: "dispatched",
    timestamp: 1_700_000_000_000,
    ...overrides,
  } as TriggerAuditEntry
}

function renderPane() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <TriggersPane />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  listAllTriggerAuditEntries.mockReset().mockReturnValue([])
  clearAllTriggerAudit.mockReset()
})

describe("filterTriggerAuditEntries", () => {
  const rows = [
    entry({ id: "a", pluginId: "demo.plugin", kind: "trigger.chat.message" }),
    entry({ id: "b", pluginId: null, kind: "trigger.chat.message" }),
    entry({ id: "c", pluginId: "demo.plugin", kind: "trigger.file.changed" }),
  ]

  it("returns everything under the default filters", () => {
    expect(filterTriggerAuditEntries(rows, ALL_TRIGGER_FILTER, ALL_TRIGGER_FILTER)).toHaveLength(3)
  })

  it("keeps only the selected plugin", () => {
    const kept = filterTriggerAuditEntries(rows, "demo.plugin", ALL_TRIGGER_FILTER)
    expect(kept.map((e) => e.id)).toEqual(["a", "c"])
  })

  it("treats a null pluginId as the built-in bucket", () => {
    // Built-in triggers carry no plugin id. Without the sentinel they would
    // be unreachable from the plugin filter entirely.
    const kept = filterTriggerAuditEntries(rows, BUILTIN_TRIGGER_FILTER, ALL_TRIGGER_FILTER)
    expect(kept.map((e) => e.id)).toEqual(["b"])
  })

  it("combines the plugin and kind filters", () => {
    const kept = filterTriggerAuditEntries(rows, "demo.plugin", "trigger.file.changed")
    expect(kept.map((e) => e.id)).toEqual(["c"])
  })
})

describe("TriggersPane", () => {
  it("shows the empty state when the ring holds nothing", () => {
    renderPane()
    expect(screen.getByTestId("triggers-empty")).toBeInTheDocument()
  })

  it("renders a row per audit entry with its status and workflow", () => {
    listAllTriggerAuditEntries.mockReturnValue([
      entry({ id: "a", status: "rejected", workflowId: "wf-rejected" }),
    ])
    renderPane()
    expect(screen.getByText("demo.plugin")).toBeInTheDocument()
    expect(screen.getByText("wf-rejected")).toBeInTheDocument()
    expect(screen.getByText(enMessages.plugins.triggers.status.rejected)).toBeInTheDocument()
  })

  it("surfaces the error message on a failed dispatch", () => {
    listAllTriggerAuditEntries.mockReturnValue([
      entry({ id: "a", status: "error", errorMessage: "handler threw" }),
    ])
    renderPane()
    expect(screen.getByText("handler threw")).toBeInTheDocument()
  })

  it("clears the ring from the clear button", async () => {
    listAllTriggerAuditEntries.mockReturnValue([entry()])
    renderPane()
    await userEvent.click(
      screen.getByRole("button", { name: enMessages.plugins.triggers.devtools.clear })
    )
    expect(clearAllTriggerAudit).toHaveBeenCalled()
  })
})
