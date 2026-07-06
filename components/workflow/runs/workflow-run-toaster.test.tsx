/**
 * @jest-environment jsdom
 */

import { render } from "@testing-library/react"
import type { WorkflowRunRow } from "@/types/workflow/visual"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

let runsValue: WorkflowRunRow[] | undefined = []
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => runsValue,
}))
jest.mock("@/lib/db/schema", () => ({ getDb: () => ({}) }))

const loading = jest.fn((..._a: unknown[]) => "toast-id")
const success = jest.fn((..._a: unknown[]) => undefined)
const error = jest.fn((..._a: unknown[]) => undefined)
jest.mock("sonner", () => ({
  toast: {
    loading: (...a: unknown[]) => loading(...a),
    success: (...a: unknown[]) => success(...a),
    error: (...a: unknown[]) => error(...a),
  },
}))

import { WorkflowRunToaster } from "./workflow-run-toaster"

function run(id: string, status: WorkflowRunRow["status"]): WorkflowRunRow {
  return {
    id,
    workflowId: "wf",
    status,
    title: "Flow",
    startedAt: 1,
  } as unknown as WorkflowRunRow
}

beforeEach(() => {
  loading.mockClear()
  success.mockClear()
  error.mockClear()
  runsValue = []
})

describe("WorkflowRunToaster", () => {
  it("opens a loading toast when an active run first appears", () => {
    runsValue = [run("r1", "running")]
    render(<WorkflowRunToaster />)
    expect(loading).toHaveBeenCalledTimes(1)
  })

  it("does NOT toast a run that is already terminal at mount", () => {
    runsValue = [run("r1", "succeeded")]
    render(<WorkflowRunToaster />)
    expect(loading).not.toHaveBeenCalled()
    expect(success).not.toHaveBeenCalled()
  })

  it("resolves running → succeeded into a success toast reusing the id", () => {
    runsValue = [run("r1", "running")]
    const { rerender } = render(<WorkflowRunToaster />)
    expect(loading).toHaveBeenCalledTimes(1)
    runsValue = [run("r1", "succeeded")]
    rerender(<WorkflowRunToaster />)
    expect(success).toHaveBeenCalledTimes(1)
    expect((success.mock.calls[0][1] as { id?: unknown }).id).toBe("toast-id")
  })

  it("resolves running → failed into an error toast", () => {
    runsValue = [run("r1", "running")]
    const { rerender } = render(<WorkflowRunToaster />)
    runsValue = [run("r1", "failed")]
    rerender(<WorkflowRunToaster />)
    expect(error).toHaveBeenCalledTimes(1)
  })
})
