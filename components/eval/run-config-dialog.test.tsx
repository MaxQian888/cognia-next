/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vals?: Record<string, unknown>) =>
    vals ? `${key}:${JSON.stringify(vals)}` : key,
}))
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }))
// The dialog reads the dataset's runs (cost estimate) + cases (units) via
// useLiveQuery; jsdom has no IndexedDB, so stub both. Mutable so the cost-guard
// tests can supply a prior run to extrapolate from.
const evalRuns = jest.fn<unknown[], []>(() => [])
const evalCases = jest.fn<unknown[], []>(() => [])
jest.mock("@/hooks/eval/use-eval-data", () => ({
  useEvalRuns: () => evalRuns(),
  useEvalCases: () => evalCases(),
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
  evalRuns.mockReturnValue([])
  evalCases.mockReturnValue([])
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
    fireEvent.click(screen.getByLabelText("scorerCatalog.cost")) // uncheck one
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
      onProgress?.({ done: 3, total: 4, passing: 1, ungraded: 2 })
      await new Promise<void>((r) => {
        release = r
      })
      return { reports: [{ runId: "r1" }], deterministicOnly: false }
    })
    render(<RunConfigDialog datasetId="d" appSettings={null} onClose={jest.fn()} />)
    fireEvent.click(screen.getByText("runConfig.run"))
    expect(await screen.findByTestId("run-progress")).toBeInTheDocument()
    // The ungraded count is shown alongside `passing`: a live "1 passing" that
    // is really "2 of these 3 were never graded" is the most misleading thing
    // this progress line can say.
    expect(
      screen.getByText('runConfig.progress:{"done":3,"total":4,"passing":1,"ungraded":2}')
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

  describe("cost guard", () => {
    // Extrapolated from the most recent run: $2 over 10 case×rep = $0.20/unit.
    const priorRun = { runId: "old", createdAt: 1, totalCostUsd: 2, caseCount: 10, k: 1 }
    const settings = (costWarnUsd?: number) =>
      ({
        defaultModel: "claude-sonnet-4-6",
        ...(costWarnUsd !== undefined ? { evalSettings: { costWarnUsd } } : {}),
      }) as never

    it("estimates cost from the most recent run once one exists", () => {
      evalRuns.mockReturnValue([priorRun])
      evalCases.mockReturnValue([{ id: "c1" }, { id: "c2" }])
      render(<RunConfigDialog datasetId="d" appSettings={settings()} onClose={jest.fn()} />)
      // 0.20/unit × 2 cases × k1 × 1 target
      expect(screen.getByText(/cost\.estimate/)).toHaveTextContent('{"cost":"0.40"}')
    })

    it("requires a second click to run once the estimate exceeds the guard", async () => {
      evalRuns.mockReturnValue([priorRun])
      evalCases.mockReturnValue([{ id: "c1" }, { id: "c2" }])
      render(<RunConfigDialog datasetId="d" appSettings={settings(0.1)} onClose={jest.fn()} />)
      expect(screen.getByText(/cost\.overBudget/)).toBeInTheDocument()
      // NOTE: the labels are currently inverted — the button reads "run anyway"
      // BEFORE the acknowledgement (where clicking only acknowledges) and
      // reverts to plain "run" for the click that actually spends the money.
      // Pinned as-is here; the run dialog's interaction rework owns the fix.
      fireEvent.click(screen.getByText("runConfig.runAnyway"))
      expect(runEvalService).not.toHaveBeenCalled()
      fireEvent.click(screen.getByText("runConfig.run"))
      await waitFor(() => expect(runEvalService).toHaveBeenCalledTimes(1))
    })

    it("does not warn when the estimate is within the guard", () => {
      evalRuns.mockReturnValue([priorRun])
      evalCases.mockReturnValue([{ id: "c1" }])
      render(<RunConfigDialog datasetId="d" appSettings={settings(100)} onClose={jest.fn()} />)
      expect(screen.queryByText(/cost\.overBudget/)).not.toBeInTheDocument()
      expect(screen.getByText("runConfig.run")).toBeInTheDocument()
    })
  })

  it("names the configured judge model in the judge indicator", () => {
    render(
      <RunConfigDialog
        datasetId="d"
        appSettings={
          { defaultModel: "m", evalSettings: { judgeModel: "claude-opus-4-8" } } as never
        }
        onClose={jest.fn()}
      />
    )
    expect(screen.getByText(/judge\.using/)).toHaveTextContent("claude-opus-4-8")
  })

  it("says so when no judge client resolves, instead of naming a model that will not run", () => {
    buildConfiguredRunDeps.mockReturnValueOnce({
      deps: { sentinel: true },
      deterministicOnly: true,
    })
    render(<RunConfigDialog datasetId="d" appSettings={null} onClose={jest.fn()} />)
    expect(screen.getByText("judge.deterministic")).toBeInTheDocument()
    expect(screen.getByText("runConfig.deterministicOnly")).toBeInTheDocument()
  })
})
