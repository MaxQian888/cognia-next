/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vals?: Record<string, unknown>) =>
    vals ? `${key}:${JSON.stringify(vals)}` : key,
}))

import type { EvalRunConfig } from "@/types/eval/run-config"

const buildConfiguredRunDeps = jest.fn(() => ({
  deps: { sentinel: true },
  deterministicOnly: false,
}))
jest.mock("@/lib/ai/eval/browser-deps", () => ({
  buildConfiguredRunDeps: (...a: unknown[]) => buildConfiguredRunDeps(...(a as [])),
}))
const runConfiguredEval = jest.fn(async (_datasetId: string, _config: EvalRunConfig) => [
  { runId: "r1" },
  { runId: "r2" },
])
jest.mock("@/lib/ai/eval/run-config", () => ({
  runConfiguredEval: (...a: unknown[]) => runConfiguredEval(...(a as [string, EvalRunConfig])),
}))

import { RunConfigDialog } from "./run-config-dialog"

beforeEach(() => {
  buildConfiguredRunDeps.mockClear()
  runConfiguredEval.mockClear()
})

describe("RunConfigDialog", () => {
  it("runs the default single chat target and reports completion", async () => {
    const onComplete = jest.fn()
    const onClose = jest.fn()
    render(
      <RunConfigDialog
        datasetId="d"
        appSettings={{ defaultModel: "claude-sonnet-4-6" } as never}
        onClose={onClose}
        onComplete={onComplete}
      />
    )
    fireEvent.click(screen.getByText("runConfig.run"))
    await waitFor(() => expect(runConfiguredEval).toHaveBeenCalled())
    const [datasetId, config] = runConfiguredEval.mock.calls[0]
    expect(datasetId).toBe("d")
    expect(config.targets).toHaveLength(1)
    expect(config.targets[0]).toMatchObject({ kind: "chat", model: "claude-sonnet-4-6" })
    expect(onComplete).toHaveBeenCalledWith(2)
    expect(onClose).toHaveBeenCalled()
  })

  it("adds a second target to form a matrix", async () => {
    render(<RunConfigDialog datasetId="d" appSettings={null} onClose={jest.fn()} />)
    fireEvent.click(screen.getByText("runConfig.addTarget"))
    const refs = screen.getAllByLabelText("runConfig.targetRef")
    expect(refs).toHaveLength(2)
    fireEvent.change(refs[1], { target: { value: "claude-opus-4-8" } })
    fireEvent.click(screen.getByText("runConfig.run"))
    await waitFor(() => expect(runConfiguredEval).toHaveBeenCalled())
    expect(runConfiguredEval.mock.calls[0][1].targets).toHaveLength(2)
  })

  it("errors when every target ref is blank", async () => {
    render(<RunConfigDialog datasetId="d" appSettings={null} onClose={jest.fn()} />)
    const ref = screen.getByLabelText("runConfig.targetRef")
    fireEvent.change(ref, { target: { value: "" } })
    fireEvent.click(screen.getByText("runConfig.run"))
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument())
    expect(runConfiguredEval).not.toHaveBeenCalled()
  })

  it("passes a scorer subset when some scorers are unchecked", async () => {
    render(<RunConfigDialog datasetId="d" appSettings={null} onClose={jest.fn()} />)
    fireEvent.click(screen.getByLabelText("cost")) // uncheck one
    fireEvent.change(screen.getByLabelText("runConfig.targetRef"), { target: { value: "m" } })
    fireEvent.click(screen.getByText("runConfig.run"))
    await waitFor(() => expect(runConfiguredEval).toHaveBeenCalled())
    const config = runConfiguredEval.mock.calls[0][1]
    expect(config.scorerIds).not.toContain("cost")
    expect(config.scorerIds.length).toBeGreaterThan(0)
  })
})
