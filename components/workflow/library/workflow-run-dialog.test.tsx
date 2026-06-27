/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

const runWorkflow = jest.fn((..._a: unknown[]) =>
  Promise.resolve({ runId: "r1", status: "succeeded" as const })
)
jest.mock("@/lib/workflow/runtime/orchestrator", () => ({
  runWorkflow: (...a: unknown[]) => runWorkflow(...a),
}))

const toastSuccess = jest.fn()
jest.mock("sonner", () => ({ toast: { success: (...a: unknown[]) => toastSuccess(...a) } }))

import { WorkflowRunDialog, parseRunPayload } from "./workflow-run-dialog"
import type { WorkflowRow } from "@/types/workflow/visual"

const workflow = {
  id: "wf-1",
  name: "My Flow",
  nodes: [],
  edges: [],
} as unknown as WorkflowRow

beforeEach(() => {
  runWorkflow.mockClear()
  toastSuccess.mockClear()
})

describe("parseRunPayload", () => {
  it("treats empty input as {}", () => {
    expect(parseRunPayload("   ")).toEqual({ ok: true, value: {} })
  })
  it("parses valid JSON", () => {
    expect(parseRunPayload('{"a":1}')).toEqual({ ok: true, value: { a: 1 } })
  })
  it("rejects invalid JSON", () => {
    expect(parseRunPayload("{not json")).toEqual({ ok: false })
  })
})

describe("WorkflowRunDialog", () => {
  it("runs the workflow with triggeredBy.source 'desktop' on submit", () => {
    render(<WorkflowRunDialog workflow={workflow} open onOpenChange={() => {}} />)
    fireEvent.click(screen.getByTestId("workflow-run-submit"))
    expect(runWorkflow).toHaveBeenCalledTimes(1)
    const arg = runWorkflow.mock.calls[0][0] as unknown as {
      triggeredBy: { source: string }
      trigger: { kind: string; payload: unknown }
    }
    expect(arg.triggeredBy.source).toBe("desktop")
    expect(arg.trigger.kind).toBe("trigger.manual")
    expect(arg.trigger.payload).toEqual({})
    expect(toastSuccess).toHaveBeenCalled()
  })

  it("blocks submit and shows an error on invalid JSON", () => {
    render(<WorkflowRunDialog workflow={workflow} open onOpenChange={() => {}} />)
    fireEvent.change(screen.getByTestId("workflow-run-payload"), {
      target: { value: "{bad" },
    })
    fireEvent.click(screen.getByTestId("workflow-run-submit"))
    expect(runWorkflow).not.toHaveBeenCalled()
    expect(screen.getByTestId("workflow-run-error")).toBeInTheDocument()
  })

  it("passes a parsed JSON payload through", () => {
    render(<WorkflowRunDialog workflow={workflow} open onOpenChange={() => {}} />)
    fireEvent.change(screen.getByTestId("workflow-run-payload"), {
      target: { value: '{"x":42}' },
    })
    fireEvent.click(screen.getByTestId("workflow-run-submit"))
    const arg = runWorkflow.mock.calls[0][0] as unknown as { trigger: { payload: unknown } }
    expect(arg.trigger.payload).toEqual({ x: 42 })
  })
})
