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
interface ServiceInput {
  datasetId: string
  config: EvalRunConfig
  signal?: AbortSignal
  onProgress?: (p: { done: number; total: number; passing: number }) => void
}
const runEvalService = jest.fn(async (_input: ServiceInput) => ({
  reports: [{ runId: "r1" }, { runId: "r2" }],
  deterministicOnly: false,
}))
jest.mock("@/lib/ai/eval/service", () => ({
  runEvalService: (...a: unknown[]) => runEvalService(...(a as [ServiceInput])),
}))

import { RunConfigDialog } from "./run-config-dialog"

beforeEach(() => {
  buildConfiguredRunDeps.mockClear()
  runEvalService.mockClear()
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
    await waitFor(() => expect(runEvalService).toHaveBeenCalled())
    const { datasetId, config } = runEvalService.mock.calls[0][0]
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
    await waitFor(() => expect(runEvalService).toHaveBeenCalled())
    expect(runEvalService.mock.calls[0][0].config.targets).toHaveLength(2)
  })

  it("errors when every target ref is blank", async () => {
    render(<RunConfigDialog datasetId="d" appSettings={null} onClose={jest.fn()} />)
    const ref = screen.getByLabelText("runConfig.targetRef")
    fireEvent.change(ref, { target: { value: "" } })
    fireEvent.click(screen.getByText("runConfig.run"))
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument())
    expect(runEvalService).not.toHaveBeenCalled()
  })

  it("passes a scorer subset when some scorers are unchecked", async () => {
    render(<RunConfigDialog datasetId="d" appSettings={null} onClose={jest.fn()} />)
    fireEvent.click(screen.getByLabelText("cost")) // uncheck one
    fireEvent.change(screen.getByLabelText("runConfig.targetRef"), { target: { value: "m" } })
    fireEvent.click(screen.getByText("runConfig.run"))
    await waitFor(() => expect(runEvalService).toHaveBeenCalled())
    const config = runEvalService.mock.calls[0][0].config
    expect(config.scorerIds).not.toContain("cost")
    expect(config.scorerIds.length).toBeGreaterThan(0)
  })

  it("renders option selects (model + character) and applies subset + k", async () => {
    render(
      <RunConfigDialog
        datasetId="d"
        appSettings={{ defaultModel: "m1" } as never}
        options={{
          models: ["m1", "m2"],
          characters: [{ id: "char-1", name: "Ada" }],
          teams: [{ id: "tm", name: "Team" }],
          workflows: [{ id: "wf", name: "Flow" }],
        }}
        onClose={jest.fn()}
      />
    )
    // RefField renders a <select> when options.models is provided
    fireEvent.change(screen.getByLabelText("runConfig.targetRef"), { target: { value: "m2" } })
    fireEvent.change(screen.getByLabelText("runConfig.character"), { target: { value: "char-1" } })
    fireEvent.change(screen.getByLabelText("runConfig.k"), { target: { value: "3" } })
    fireEvent.change(screen.getByLabelText("runConfig.split"), { target: { value: "test" } })
    fireEvent.change(screen.getByLabelText("runConfig.capabilities"), { target: { value: "a, b" } })
    fireEvent.click(screen.getByText("runConfig.run"))
    await waitFor(() => expect(runEvalService).toHaveBeenCalled())
    const config = runEvalService.mock.calls[0][0].config
    expect(config.targets[0]).toMatchObject({ kind: "chat", model: "m2", characterId: "char-1" })
    expect(config.k).toBe(3)
    expect(config.subset).toEqual({ split: "test", capabilities: ["a", "b"] })
  })

  it("builds team and workflow target specs from the kind select", async () => {
    render(<RunConfigDialog datasetId="d" appSettings={null} onClose={jest.fn()} />)
    fireEvent.change(screen.getByLabelText("runConfig.targetKind"), { target: { value: "team" } })
    fireEvent.change(screen.getByLabelText("runConfig.targetRef"), { target: { value: "tm1" } })
    fireEvent.click(screen.getByText("runConfig.addTarget"))
    fireEvent.change(screen.getAllByLabelText("runConfig.targetKind")[1], {
      target: { value: "workflow" },
    })
    fireEvent.change(screen.getAllByLabelText("runConfig.targetRef")[1], {
      target: { value: "wf1" },
    })
    fireEvent.click(screen.getByText("runConfig.run"))
    await waitFor(() => expect(runEvalService).toHaveBeenCalled())
    const config = runEvalService.mock.calls[0][0].config
    expect(config.targets[0]).toMatchObject({ kind: "team", teamId: "tm1" })
    expect(config.targets[1]).toMatchObject({ kind: "workflow", workflowId: "wf1" })
  })

  it("surfaces a service failure as an alert", async () => {
    runEvalService.mockRejectedValueOnce(new Error("boom"))
    render(<RunConfigDialog datasetId="d" appSettings={null} onClose={jest.fn()} />)
    fireEvent.click(screen.getByText("runConfig.run"))
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument())
  })

  it("shows progress while running and supports cancel", async () => {
    let capturedSignal: AbortSignal | undefined
    let release: () => void = () => {}
    runEvalService.mockImplementationOnce(async ({ onProgress, signal }: ServiceInput) => {
      capturedSignal = signal
      onProgress?.({ done: 1, total: 4, passing: 1 })
      await new Promise<void>((r) => {
        release = r
      })
      return { reports: [{ runId: "r1" }], deterministicOnly: false }
    })
    render(<RunConfigDialog datasetId="d" appSettings={null} onClose={jest.fn()} />)
    fireEvent.click(screen.getByText("runConfig.run"))
    expect(await screen.findByTestId("run-progress")).toBeInTheDocument()
    expect(
      screen.getByText('runConfig.progress:{"done":1,"total":4,"passing":1}')
    ).toBeInTheDocument()
    fireEvent.click(screen.getByText("runConfig.cancelRun"))
    expect(capturedSignal?.aborted).toBe(true)
    release()
  })

  it("removes an added target row", () => {
    render(<RunConfigDialog datasetId="d" appSettings={null} onClose={jest.fn()} />)
    fireEvent.click(screen.getByText("runConfig.addTarget"))
    expect(screen.getAllByLabelText("runConfig.targetRef")).toHaveLength(2)
    fireEvent.click(screen.getAllByLabelText("runConfig.removeTarget")[0])
    expect(screen.getAllByLabelText("runConfig.targetRef")).toHaveLength(1)
  })
})
