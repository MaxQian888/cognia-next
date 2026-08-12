/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react"
import { ContextInspector } from "./context-inspector"
import enSecurity from "@/i18n/messages/en/settings/security.json"
import zhSecurity from "@/i18n/messages/zh-CN/settings/security.json"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

let liveValue: { contexts: unknown[]; auditGaps: unknown[] } = { contexts: [], auditGaps: [] }
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => liveValue,
}))

const context = (id: string, outcome: string, openConflict = false) => ({
  decision: {
    id,
    kind: "workflow-branch",
    question: { code: "select-edge" },
    resolution: { outcome, reasonCode: `reason-${id}` },
    lifecycle: { state: "executed" },
  },
  evidence: [{ id: `evidence-${id}` }],
  events: [{ id: `event-${id}` }],
  lineage: [],
  provenance: [{ eventId: `provenance-${id}` }],
  conflicts: openConflict ? [{ id: `conflict-${id}`, status: "open" }] : [],
})

beforeEach(() => {
  liveValue = { contexts: [], auditGaps: [] }
})

it("keeps the split-source translations in parity", () => {
  expect(Object.keys(enSecurity.contextInspector).sort()).toEqual(
    Object.keys(zhSecurity.contextInspector).sort()
  )
})

it("renders an empty state before governance decisions exist", () => {
  render(<ContextInspector />)
  expect(screen.getByText("empty")).toBeInTheDocument()
})

it("surfaces governance projection audit gaps even without decisions", () => {
  liveValue = {
    contexts: [],
    auditGaps: [{ eventId: "gap-1" }, { eventId: "gap-2" }],
  }

  render(<ContextInspector />)

  expect(screen.getByRole("status")).toHaveTextContent("auditGap")
  expect(screen.getByRole("status")).toHaveTextContent("2")
})

it("switches decisions and explains evidence, provenance, and open conflicts", () => {
  liveValue = {
    contexts: [context("decision-1", "left"), context("decision-2", "right", true)],
    auditGaps: [],
  }
  render(<ContextInspector />)

  expect(screen.getByText("reason-decision-1")).toBeInTheDocument()
  fireEvent.click(screen.getByText("right"))
  expect(screen.getByText("reason-decision-2")).toBeInTheDocument()
  expect(screen.getByText("open")).toBeInTheDocument()
})
