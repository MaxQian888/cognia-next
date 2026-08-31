/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const mockListDatasetSummaries = jest.fn<Promise<unknown>, unknown[]>(
  () => new Promise<unknown>(() => {})
)
const mockListCalibrationRuns = jest.fn<Promise<unknown>, unknown[]>(
  () => new Promise<unknown>(() => {})
)
const mockRecoverQueue = jest.fn<Promise<unknown>, unknown[]>(() => new Promise<unknown>(() => {}))
const mockCheckEnvironment = jest.fn<Promise<unknown>, unknown[]>(
  () => new Promise<unknown>(() => {})
)
const mockLoadDatasetSelection = jest.fn(async (..._args: unknown[]): Promise<unknown> => undefined)
const mockEnsureStarterDataset = jest.fn(async (..._args: unknown[]): Promise<unknown> => undefined)
const mockSaveProject = jest.fn(async (..._args: unknown[]) => {})
const mockListProjects = jest.fn<Promise<unknown>, unknown[]>(() => new Promise<unknown>(() => {}))
const mockListExperiments = jest.fn(async (..._args: unknown[]): Promise<unknown[]> => [])
const mockLatestApplication = jest.fn(async (..._args: unknown[]): Promise<unknown> => undefined)
const mockDeleteExpiredArtifacts = jest.fn(async () => ({ samplesDeleted: 0, assetsDeleted: 0 }))
const mockLoadArtifactKey = jest.fn(async (..._args: unknown[]) => new Uint8Array(32))
const mockOrchestratorRun = jest.fn(async (..._args: unknown[]) => {})
const mockLoadReport = jest.fn(async (..._args: unknown[]): Promise<unknown> => undefined)
const mockServiceStart = jest.fn(async (..._args: unknown[]): Promise<unknown> => undefined)
const mockServiceStatus = jest.fn(async (..._args: unknown[]): Promise<unknown> => undefined)
const mockServicePause = jest.fn(async (..._args: unknown[]) => {})
const mockServiceResume = jest.fn(async (..._args: unknown[]) => {})
const mockServiceCancel = jest.fn(async (..._args: unknown[]) => {})
const mockServiceExtendBudget = jest.fn(async (..._args: unknown[]) => {})
let mockCurrentConfiguration: Record<string, unknown> = { providerId: "old", modelId: "old" }
const mockApplicationRead = jest.fn(async (..._args: unknown[]) => mockCurrentConfiguration)
const mockApplicationWrite = jest.fn(async (...args: unknown[]) => {
  const value = args[1] as Record<string, unknown>
  mockCurrentConfiguration = value
})
let mockSettings: Record<string, unknown> | null = null
let mockAccountId: string | null = null
let mockSavedApplication: Record<string, unknown> | undefined
const mockRunOptions = {
  models: ["model-a", "model-b"],
  characters: [{ id: "character-a", name: "Character A" }],
  teams: [{ id: "team-a", name: "Team A" }],
  workflows: [{ id: "workflow-a", name: "Workflow A" }],
  twins: [],
}

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useFormatter: () => ({
    number: (value: number, options?: Intl.NumberFormatOptions) =>
      new Intl.NumberFormat("en-US", options).format(value),
    dateTime: (value: number) => new Date(value).toISOString(),
  }),
}))
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }))
jest.mock("@/lib/ai/eval/service", () => ({
  listDatasetSummaries: () => mockListDatasetSummaries(),
}))
jest.mock("@/lib/db/calibration-runs", () => ({
  listRecentCalibrationRuns: () => mockListCalibrationRuns(),
}))
jest.mock("@/lib/ai/eval/recovery", () => ({
  recoverEvalQueueOnStartup: () => mockRecoverQueue(),
}))
jest.mock("@/lib/ai/eval/environment-preflight", () => ({
  checkEvalEnvironmentCompatibility: () => mockCheckEnvironment(),
  applyEnvironmentReadiness: (project: { variants: Array<Record<string, unknown>> }) => ({
    ...project,
    variants: project.variants.map((variant) => ({ ...variant, runtimeReady: true })),
  }),
}))
jest.mock("@/lib/ai/eval/project-inputs", () => ({
  listEvalProviderIds: () => ["provider-a", "provider-b"],
  resolveEvalProviderLocality: () => false,
  loadEvalDatasetSelection: (...args: unknown[]) => mockLoadDatasetSelection(...args),
  resolveEvalVariantReadiness: (variant: { providerId?: string; modelId?: string }) => ({
    ...variant,
    available: Boolean(variant.providerId && variant.modelId),
    credentialReady: Boolean(variant.providerId && variant.modelId),
    runtimeReady: true,
  }),
}))
jest.mock("@/lib/ai/eval/starter-template", () => ({
  ensureEvalStarterDataset: (...args: unknown[]) => mockEnsureStarterDataset(...args),
}))
jest.mock("@/lib/db/eval-lab", () => ({
  saveEvalProject: (...args: unknown[]) => mockSaveProject(...args),
  listEvalProjects: () => mockListProjects(),
  listEvalExperiments: (...args: unknown[]) => mockListExperiments(...args),
  getLatestEvalConfigurationApply: (...args: unknown[]) => mockLatestApplication(...args),
  deleteExpiredEvalArtifacts: () => mockDeleteExpiredArtifacts(),
}))
jest.mock("@/lib/ai/eval/artifact-crypto", () => ({
  loadOrCreateEvalArtifactKey: (...args: unknown[]) => mockLoadArtifactKey(...args),
}))
jest.mock("@/lib/ai/eval/browser-execution", () => ({
  createBrowserEvalOrchestrator: () => ({
    run: (...args: unknown[]) => mockOrchestratorRun(...args),
  }),
}))
jest.mock("@/lib/ai/eval/report-view", () => ({
  filterEvalReportCases: (cases: unknown[]) => cases,
  loadEvalReportView: (...args: unknown[]) => mockLoadReport(...args),
}))
jest.mock("@/lib/ai/eval/configuration-targets", () => ({
  browserEvalConfigurationApplicationDeps: async () => ({
    read: (...args: unknown[]) => mockApplicationRead(...args),
    write: (...args: unknown[]) => mockApplicationWrite(...args),
    saveRecord: jest.fn(async (record: Record<string, unknown>) => {
      mockSavedApplication = record
    }),
    getRecord: jest.fn(async () => mockSavedApplication),
    updateRecord: jest.fn(async (_id: string, patch: Record<string, unknown>) => {
      mockSavedApplication = { ...mockSavedApplication, ...patch }
    }),
    now: () => 100,
    newId: () => "application-1",
  }),
}))
jest.mock("@/lib/ai/eval/project-service", () => ({
  EvalProjectService: class {
    start(...args: unknown[]) {
      return mockServiceStart(...args)
    }
    status(...args: unknown[]) {
      return mockServiceStatus(...args)
    }
    pause(...args: unknown[]) {
      return mockServicePause(...args)
    }
    resume(...args: unknown[]) {
      return mockServiceResume(...args)
    }
    cancel(...args: unknown[]) {
      return mockServiceCancel(...args)
    }
    extendBudget(...args: unknown[]) {
      return mockServiceExtendBudget(...args)
    }
  },
}))
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (state: { settings: Record<string, unknown> | null }) => unknown) =>
    selector({ settings: mockSettings }),
}))
jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: (selector: (state: { unlockedAccountId: string | null }) => unknown) =>
    selector({ unlockedAccountId: mockAccountId }),
}))
jest.mock("@/hooks/eval/use-run-config-options", () => ({
  useRunConfigOptions: () => mockRunOptions,
}))
jest.mock("@/lib/ai/model-options", () => ({
  collectModelOptions: () => [
    {
      providerId: "provider-a",
      providerName: "Provider A",
      modelId: "model-a",
      modelName: "Model A",
    },
    {
      providerId: "provider-b",
      providerName: "Provider B",
      modelId: "model-b",
      modelName: "Model B",
    },
  ],
}))
jest.mock("./eval-dashboard", () => ({ EvalDashboard: () => <div>LEGACY_DATASETS</div> }))
jest.mock("./runs-compare-panel", () => ({ RunsComparePanel: () => <div>LEGACY_RUNS</div> }))
jest.mock("./trace-annotation-panel", () => ({
  TraceAnnotationPanel: () => <div>LEGACY_TRACES</div>,
}))
jest.mock("./calibration-panel", () => ({ CalibrationPanel: () => <div>LEGACY_CALIBRATION</div> }))

import { EvalLabWorkspace } from "./eval-lab-workspace"

describe("EvalLabWorkspace", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockSettings = null
    mockAccountId = null
    mockSavedApplication = undefined
    mockCurrentConfiguration = { providerId: "old", modelId: "old" }
    mockListDatasetSummaries.mockImplementation(() => new Promise<never>(() => {}))
    mockListCalibrationRuns.mockImplementation(() => new Promise<never>(() => {}))
    mockRecoverQueue.mockImplementation(() => new Promise<never>(() => {}))
    mockCheckEnvironment.mockImplementation(() => new Promise<never>(() => {}))
    mockListProjects.mockImplementation(() => new Promise<never>(() => {}))
    mockListExperiments.mockResolvedValue([])
    mockLatestApplication.mockResolvedValue(undefined)
    mockDeleteExpiredArtifacts.mockResolvedValue({ samplesDeleted: 0, assetsDeleted: 0 })
  })
  it("renders the complete guided project flow and switches modes", () => {
    render(<EvalLabWorkspace />)

    expect(screen.getByRole("navigation", { name: "lab.steps.label" })).toBeInTheDocument()
    expect(screen.getAllByRole("button", { name: /lab\.steps\./ })).toHaveLength(7)
    fireEvent.click(screen.getByRole("button", { name: "lab.mode.agent" }))
    expect(screen.getByRole("button", { name: "lab.mode.agent" })).toHaveAttribute(
      "aria-pressed",
      "true"
    )
  })

  it("supports keyboard step navigation and persistent mobile actions", () => {
    render(<EvalLabWorkspace />)
    const goal = screen.getByRole("button", { name: "lab.steps.goal" })
    fireEvent.keyDown(goal, { key: "ArrowDown" })

    expect(screen.getByRole("heading", { name: "lab.data.title" })).toBeInTheDocument()
    expect(screen.getByTestId("eval-lab-mobile-actions")).toBeInTheDocument()
  })

  it("shows blocking preflight evidence for incomplete provider variants", () => {
    render(<EvalLabWorkspace />)
    fireEvent.click(screen.getByRole("button", { name: "lab.steps.preflight" }))

    expect(screen.getByText("lab.preflight.blocked")).toBeInTheDocument()
    expect(screen.getAllByTestId("preflight-issue").length).toBeGreaterThan(0)
  })

  it("keeps legacy datasets and calibration available as secondary tools", async () => {
    const user = userEvent.setup()
    render(<EvalLabWorkspace />)
    await user.click(screen.getByRole("button", { name: "lab.legacy.open" }))
    await user.click(screen.getByRole("menuitem", { name: "tabs.datasets" }))
    expect(screen.getByText("LEGACY_DATASETS")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "lab.legacy.open" }))
    await user.click(screen.getByRole("menuitem", { name: "tabs.calibrate" }))
    expect(screen.getByText("LEGACY_CALIBRATION")).toBeInTheDocument()
  })

  it("lets users declare the full attachment and Agent capability contract", async () => {
    const user = userEvent.setup()
    render(<EvalLabWorkspace />)
    await user.click(screen.getByRole("button", { name: "lab.steps.variants" }))

    const structuredOutput = screen.getAllByRole("switch", {
      name: "lab.variants.capability.structured-output",
    })[0]
    expect(structuredOutput).not.toBeChecked()
    await user.click(structuredOutput)
    expect(structuredOutput).toBeChecked()
    expect(screen.getAllByRole("switch", { name: "lab.variants.capability.audio" })).toHaveLength(2)
    expect(screen.getAllByRole("switch", { name: "lab.variants.capability.video" })).toHaveLength(2)
    expect(
      screen.getAllByRole("switch", { name: "lab.variants.capability.document" })
    ).toHaveLength(2)
    expect(screen.getAllByRole("switch", { name: "lab.variants.capability.rag" })).toHaveLength(2)
    expect(
      screen.getAllByRole("switch", { name: "lab.variants.capability.trajectory" })
    ).toHaveLength(2)
  })

  it("exposes an evidence drawer and prevents page-level horizontal overflow", () => {
    render(<EvalLabWorkspace />)
    const root = screen.getByTestId("eval-lab-workspace")
    expect(root).toHaveClass("overflow-hidden")
    expect(root).toHaveClass("relative")
    expect(screen.getByTestId("eval-evidence-panel")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "lab.evidence.open" }))
    expect(screen.getByRole("dialog")).toHaveTextContent("lab.evidence.title")
  })

  it("uses motion-safe transitions so reduced-motion users get static state changes", () => {
    render(<EvalLabWorkspace />)
    expect(screen.getByTestId("eval-lab-canvas").className).toContain("motion-safe:")
    expect(screen.getByTestId("eval-lab-canvas").className).not.toContain("animate-")
  })

  it("renders every guided configuration and reporting step without page tabs", async () => {
    const user = userEvent.setup()
    render(<EvalLabWorkspace />)

    for (const [step, heading] of [
      ["scoring", "lab.scoring.title"],
      ["run", "lab.run.title"],
      ["review", "lab.review.title"],
    ] as const) {
      await user.click(screen.getByRole("button", { name: `lab.steps.${step}` }))
      expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument()
    }
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument()
  })

  it("edits the project goal and formal scoring policy controls", async () => {
    const user = userEvent.setup()
    render(<EvalLabWorkspace />)

    await user.type(screen.getByLabelText("lab.project.name"), "Support routing")
    await user.type(screen.getByLabelText("lab.project.description"), "Choose a default")
    expect(screen.getByDisplayValue("Support routing")).toBeInTheDocument()
    expect(screen.getByDisplayValue("Choose a default")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "lab.steps.scoring" }))
    const formal = screen.getByRole("switch", { name: "lab.scoring.formal" })
    expect(formal).toBeChecked()
    await user.click(formal)
    expect(formal).not.toBeChecked()
    const budget = screen.getByLabelText("lab.scoring.budget")
    await user.clear(budget)
    await user.type(budget, "25")
    expect(budget).toHaveValue(25)
  })

  it("edits and persists every decision-policy field without flattening custom policy data", async () => {
    const user = userEvent.setup()
    mockListProjects.mockResolvedValue([])
    render(<EvalLabWorkspace />)
    await user.click(screen.getByRole("button", { name: "lab.steps.scoring" }))

    await user.click(screen.getByRole("button", { name: "lab.scoring.addDimension" }))
    const metric = document.getElementById("eval-dimension-3-metric")
    const weight = document.getElementById("eval-dimension-3-weight")
    const direction = document.getElementById("eval-dimension-3-direction")
    expect(metric).toBeInstanceOf(HTMLInputElement)
    expect(weight).toBeInstanceOf(HTMLInputElement)
    expect(direction).toBeInstanceOf(HTMLSelectElement)
    await user.clear(metric as HTMLInputElement)
    await user.type(metric as HTMLInputElement, "safety")
    await user.clear(weight as HTMLInputElement)
    await user.type(weight as HTMLInputElement, "0.4")
    await user.selectOptions(direction as HTMLSelectElement, "minimize")

    await user.click(screen.getByRole("button", { name: "lab.scoring.addConstraint" }))
    expect(screen.getAllByLabelText("lab.scoring.operator")).toHaveLength(2)
    await user.click(screen.getAllByRole("button", { name: "lab.scoring.removeConstraint" })[1])
    expect(screen.getAllByLabelText("lab.scoring.operator")).toHaveLength(1)

    for (const [label, value] of [
      ["lab.scoring.confidence", "0.9"],
      ["lab.scoring.minimumCases", "12"],
      ["lab.scoring.retentionDays", "45"],
    ] as const) {
      const input = screen.getByLabelText(label)
      await user.clear(input)
      await user.type(input, value)
    }

    const judgeProvider = screen.getByLabelText("lab.scoring.judgeProvider")
    const judgeModel = screen.getByLabelText("lab.scoring.judgeModel")
    await user.type(judgeProvider, "provider-a")
    await user.type(judgeModel, "model-a")
    await user.clear(judgeProvider)
    await user.type(judgeProvider, "provider-b")
    expect(judgeModel).toHaveValue("")

    await user.click(screen.getByRole("button", { name: "lab.steps.goal" }))
    await user.click(screen.getByRole("button", { name: "lab.project.saveDraft" }))
    await waitFor(() =>
      expect(mockSaveProject).toHaveBeenCalledWith(
        expect.objectContaining({
          retentionDays: 45,
          decisionPolicy: expect.objectContaining({
            confidenceLevel: 0.9,
            minimumEffectiveCases: 12,
            dimensions: expect.arrayContaining([
              { metric: "safety", direction: "minimize", weight: 0.4 },
            ]),
          }),
        })
      )
    )
  })

  it("surfaces project action failures outside the run step", async () => {
    const user = userEvent.setup()
    mockSaveProject.mockRejectedValueOnce(new Error("storage unavailable"))
    render(<EvalLabWorkspace />)

    await user.click(screen.getByRole("button", { name: "lab.project.saveDraft" }))

    expect(await screen.findByText("lab.actions.error")).toBeInTheDocument()
    expect(screen.getByText("storage unavailable")).toBeInTheDocument()
  })

  it("configures Agent target kinds, trusted locality, prices, and explicit capabilities", async () => {
    const user = userEvent.setup()
    render(<EvalLabWorkspace />)
    await user.click(screen.getByRole("button", { name: "lab.steps.goal" }))
    await user.click(screen.getByRole("button", { name: "lab.mode.agent" }))
    await user.click(screen.getByRole("button", { name: "lab.steps.variants" }))

    const kinds = screen.getAllByLabelText("lab.variants.agentTarget")
    await user.selectOptions(kinds[0], "workflow")
    expect(screen.getAllByLabelText("lab.variants.targetIds.workflow")[0]).toBeInTheDocument()
    await user.type(screen.getAllByLabelText("lab.variants.targetIds.workflow")[0], "workflow-1")
    await user.type(screen.getAllByLabelText("lab.variants.workflowVersion")[0], "version-1")
    expect(screen.getAllByLabelText("lab.variants.workflowVersion")[0]).toHaveValue("version-1")
    await user.selectOptions(kinds[0], "team")
    expect(screen.getAllByLabelText("lab.variants.targetIds.team")[0]).toHaveValue("")
    expect(screen.queryByLabelText("lab.variants.workflowVersion")).not.toBeInTheDocument()
    expect(
      screen.getAllByRole("switch", { name: "lab.variants.capability.image" })[0]
    ).toBeDisabled()

    expect(screen.getAllByText("lab.variants.cloudOrUnverified")[0]).toBeInTheDocument()
    expect(screen.getAllByLabelText("lab.variants.inputPrice")[0]).toBeInTheDocument()
    await user.type(screen.getAllByLabelText("lab.variants.inputPrice")[0], "1.5")
    await user.type(screen.getAllByLabelText("lab.variants.outputPrice")[0], "3")
    expect(screen.queryByLabelText("lab.variants.deployment")).not.toBeInTheDocument()
    expect(screen.queryByLabelText("lab.variants.temperature")).not.toBeInTheDocument()
    expect(screen.queryByLabelText("lab.variants.topP")).not.toBeInTheDocument()
    expect(screen.queryByLabelText("lab.variants.maxOutputTokens")).not.toBeInTheDocument()
    expect(screen.queryByLabelText("lab.variants.systemPrompt")).not.toBeInTheDocument()
  })

  it("manages candidates and offers provider-scoped model and Agent target choices", async () => {
    const user = userEvent.setup()
    render(<EvalLabWorkspace />)
    await user.click(screen.getByRole("button", { name: "lab.steps.variants" }))

    expect(screen.getAllByLabelText("lab.variants.name")).toHaveLength(2)
    expect(document.querySelector('#variant-a-model-ids option[value="model-a"]')).toHaveAttribute(
      "label",
      "Model A"
    )
    expect(screen.getAllByLabelText("lab.variants.temperature")).toHaveLength(2)
    const firstProvider = screen.getAllByLabelText("lab.variants.provider")[0]
    const firstModel = screen.getAllByLabelText("lab.variants.model")[0]
    await user.type(firstProvider, "provider-a")
    await user.type(firstModel, "model-a")
    await user.clear(firstProvider)
    await user.type(firstProvider, "provider-b")
    expect(firstModel).toHaveValue("")
    expect(document.querySelector('#variant-a-model-ids option[value="model-a"]')).toBeNull()
    expect(document.querySelector('#variant-a-model-ids option[value="model-b"]')).toHaveAttribute(
      "label",
      "Model B"
    )

    await user.click(screen.getAllByRole("button", { name: "lab.variants.duplicate" })[0])
    expect(screen.getAllByLabelText("lab.variants.name")).toHaveLength(3)
    await user.clear(screen.getAllByLabelText("lab.variants.name")[2])
    await user.type(screen.getAllByLabelText("lab.variants.name")[2], "Candidate C")
    expect(screen.getByDisplayValue("Candidate C")).toBeInTheDocument()

    await user.click(screen.getAllByRole("button", { name: "lab.variants.remove" })[2])
    expect(screen.getAllByLabelText("lab.variants.name")).toHaveLength(2)
    expect(screen.getAllByRole("button", { name: "lab.variants.remove" })[0]).toBeDisabled()

    await user.click(screen.getByRole("button", { name: "lab.steps.goal" }))
    await user.click(screen.getByRole("button", { name: "lab.mode.agent" }))
    await user.click(screen.getByRole("button", { name: "lab.steps.variants" }))
    const target = screen.getAllByLabelText("lab.variants.targetIds.chat")[0]
    expect(target).toHaveAttribute("list", "variant-a-chat-targets")
    expect(
      document.querySelector('#variant-a-chat-targets option[value="character-a"]')
    ).toHaveAttribute("label", "Character A")
  })

  it("navigates with persistent next and back actions", async () => {
    const user = userEvent.setup()
    render(<EvalLabWorkspace />)

    const next = screen.getAllByRole("button", { name: "lab.actions.next" })[0]
    await user.click(next)
    expect(screen.getByRole("heading", { name: "lab.data.title" })).toBeInTheDocument()
    const back = screen.getAllByRole("button", { name: "lab.actions.back" })[0]
    await user.click(back)
    expect(screen.getByRole("heading", { name: "lab.goal.title" })).toBeInTheDocument()
  })

  it("runs the persisted project, renders complete evidence, applies, and rolls back explicitly", async () => {
    const user = userEvent.setup()
    const cases = Array.from({ length: 30 }, (_, index) => `case-${index}`)
    const environment = {
      checkedAt: 10,
      runtimeByVariant: {
        "variant-a": { available: true },
        "variant-b": { available: true },
      },
      storage: { status: "available" as const, requiredBytes: 1, availableBytes: 100 },
    }
    const manifest = {
      id: "experiment-1",
      projectId: "project-1",
      projectRevision: "sha256:project",
      dataset: {
        datasetId: "eval-lab-starter-v1",
        version: 1,
        digest: "sha256:dataset",
        caseIds: cases,
        holdoutCaseIds: cases,
        requiredModalities: ["text"],
      },
      variants: [
        {
          id: "variant-a",
          name: "A",
          kind: "model",
          providerId: "provider-a",
          modelId: "model-a",
          runtimeTarget: "web",
          isLocal: true,
          capabilities: ["text"],
          available: true,
          credentialReady: true,
        },
        {
          id: "variant-b",
          name: "B",
          kind: "model",
          providerId: "provider-b",
          modelId: "model-b",
          runtimeTarget: "web",
          isLocal: true,
          capabilities: ["text"],
          available: true,
          credentialReady: true,
        },
      ],
      mode: "model",
      appVersion: "1.0.0",
      scorerVersions: { exact: "1" },
      privacyPolicy: { cloudPiiMode: "redact", mediaClearance: "local-only" },
      randomSeed: 42,
      budget: { currency: "USD", hardCap: 10, confirmed: true },
      judgePolicy: { enabled: false, calibrated: false, anchorCount: 0, kappa: 0, accuracy: 0 },
      decisionPolicy: {
        formal: false,
        dimensions: [{ metric: "quality", direction: "maximize", weight: 1 }],
        constraints: [],
        confidenceLevel: 0.95,
        minimumEffectiveCases: 30,
      },
      retentionDays: 90,
      adaptiveRepetitions: { stageOne: 1, maximum: 3 },
      environmentCompatibility: environment,
      createdAt: 1,
    }
    const evidenceCase = (variantId: string, sampleId: string, output: string) => ({
      case: {
        id: "case-0",
        datasetId: "dataset-1",
        input: "Question",
        capability: "chat.qa",
        source: "handwritten",
        split: "test",
        createdAt: 1,
        updatedAt: 1,
      },
      sample: {
        output,
        latencyMs: 10,
        costUsd: 0,
        toolCalls: [],
        retrievedChunks: [],
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
        stepCount: 0,
        degraded: false,
      },
      variantId,
      repetition: 1,
      sampleId,
      taskId: `task-${variantId}`,
      scores: [
        {
          id: `score-${variantId}`,
          experimentId: "experiment-1",
          sampleId,
          scorerId: "exact",
          value: 1,
          passed: true,
          scorerVersion: "1",
          createdAt: 1,
        },
      ],
      status: "passed",
    })
    mockSettings = { defaultProvider: "provider-a", providerSettings: {}, customProviders: [] }
    mockAccountId = "account-1"
    mockListDatasetSummaries.mockResolvedValue([])
    mockListCalibrationRuns.mockResolvedValue([])
    mockListProjects.mockResolvedValue([])
    mockRecoverQueue.mockResolvedValue([])
    mockCheckEnvironment.mockResolvedValue(environment)
    mockEnsureStarterDataset.mockResolvedValue({ id: "eval-lab-starter-v1" })
    mockLoadDatasetSelection.mockResolvedValue(manifest.dataset)
    mockServiceStart.mockResolvedValue({ id: "experiment-1", state: "queued" })
    mockServiceStatus.mockResolvedValue({
      experiment: {
        state: "completed",
        spentCost: 0.2,
        reservedCost: 0,
        budgetCap: 10,
        manifest,
      },
      tasks: { completed: 60 },
    })
    mockLoadReport.mockResolvedValue({
      experiment: { id: "experiment-1", manifest },
      recommendation: {
        result: {
          status: "recommended",
          recommendedVariantId: "variant-a",
          paretoVariantIds: ["variant-a"],
          utilityByVariant: { "variant-a": 1 },
          excluded: [],
        },
      },
      evidence: [
        {
          variantId: "variant-a",
          effectiveCases: 30,
          metrics: { quality: 1, reliability: 1, cost: 0.2, latency: 0.1 },
          intervals: {
            quality: { low: 0.9, high: 1 },
            reliability: { low: 0.9, high: 1 },
            cost: { low: 0.1, high: 0.3 },
            latency: { low: 0.05, high: 0.2 },
          },
          calibrationPassed: true,
        },
      ],
      cases: [
        evidenceCase("variant-a", "sample-a", "Answer A"),
        evidenceCase("variant-b", "sample-b", "Answer B"),
      ],
      cost: { actual: 0.2, estimatedWorstCase: 1, hardCap: 10 },
      providerErrors: [{ taskId: "task-error", providerId: "provider-a", error: "retry" }],
    })

    render(<EvalLabWorkspace />)
    await user.click(screen.getByRole("button", { name: "lab.steps.data" }))
    await user.click(screen.getByRole("button", { name: "lab.data.useStarter" }))
    await waitFor(() => expect(screen.getByText("lab.data.selected")).toBeInTheDocument())
    await user.click(screen.getByRole("button", { name: "lab.steps.variants" }))
    const providers = screen.getAllByLabelText("lab.variants.provider")
    const models = screen.getAllByLabelText("lab.variants.model")
    await user.type(providers[0], "provider-a")
    await user.type(models[0], "model-a")
    await user.type(providers[1], "provider-b")
    await user.type(models[1], "model-b")
    for (const input of screen.getAllByLabelText("lab.variants.inputPrice")) {
      await user.type(input, "1")
    }
    for (const output of screen.getAllByLabelText("lab.variants.outputPrice")) {
      await user.type(output, "2")
    }
    await user.click(screen.getByRole("button", { name: "lab.steps.scoring" }))
    await user.click(screen.getByRole("switch", { name: "lab.scoring.formal" }))
    await user.click(screen.getByRole("button", { name: "lab.steps.run" }))
    const start = screen.getByRole("button", { name: "lab.run.start" })
    await waitFor(() => expect(start).toBeEnabled())
    await user.click(start)
    await waitFor(() =>
      expect(mockLoadReport).toHaveBeenCalledWith("experiment-1", expect.any(Uint8Array))
    )

    await user.click(screen.getByRole("button", { name: "lab.steps.review" }))
    expect(screen.getByText("lab.review.recommended")).toBeInTheDocument()
    expect(screen.getByText("lab.review.frontier")).toBeInTheDocument()
    expect(screen.getByText("lab.review.providerErrors")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "lab.review.apply.preview" }))
    await waitFor(() => expect(screen.getByText("providerId")).toBeInTheDocument())
    await user.click(screen.getByRole("button", { name: "lab.review.apply.confirm" }))
    await waitFor(() => expect(mockApplicationWrite).toHaveBeenCalled())
    await user.click(screen.getByRole("button", { name: "lab.review.apply.rollback" }))
    await waitFor(() => expect(mockApplicationWrite).toHaveBeenCalledTimes(2))
  }, 20_000)

  it("saves and restores long-lived project definitions before any experiment runs", async () => {
    const user = userEvent.setup()
    const saved = {
      id: "saved-project",
      name: "Saved selection",
      description: "Reusable decision",
      mode: "agent" as const,
      dataset: {
        datasetId: "dataset",
        version: 2,
        digest: "sha256:saved",
        caseIds: ["case"],
        holdoutCaseIds: [],
        requiredModalities: ["text" as const],
      },
      variants: [],
      decisionPolicy: {
        formal: false,
        dimensions: [{ metric: "custom-quality", direction: "maximize" as const, weight: 7 }],
        constraints: [{ metric: "custom-quality", operator: "gte" as const, value: 0.7 }],
        confidenceLevel: 0.9,
        minimumEffectiveCases: 12,
      },
      budget: { currency: "USD", hardCap: 12, confirmed: true },
      judgePolicy: {
        enabled: false,
        calibrated: false,
        anchorCount: 0,
        kappa: 0,
        accuracy: 0,
      },
      privacyPolicy: { cloudPiiMode: "redact" as const, mediaClearance: "local-only" as const },
      retentionDays: 90,
      createdAt: 1,
      updatedAt: 2,
    }
    mockListDatasetSummaries.mockResolvedValue([])
    mockListCalibrationRuns.mockResolvedValue([])
    mockListProjects.mockResolvedValue([saved])
    mockListExperiments.mockResolvedValue([
      { id: "completed-experiment", state: "completed", createdAt: 3 },
    ])
    mockLatestApplication.mockResolvedValue({ id: "apply-1", rolledBackAt: undefined })
    mockServiceStatus.mockResolvedValue({
      experiment: {
        state: "completed",
        spentCost: 0.5,
        reservedCost: 0,
        manifest: { budget: { hardCap: 12 } },
      },
      tasks: { completed: 1 },
    })

    render(<EvalLabWorkspace />)
    const projectPicker = await screen.findByLabelText("lab.project.saved")
    await user.selectOptions(projectPicker, "saved-project")
    expect(screen.getByLabelText("lab.project.name")).toHaveValue("Saved selection")
    expect(screen.getByRole("button", { name: "lab.mode.agent" })).toHaveAttribute(
      "aria-pressed",
      "true"
    )

    await user.click(screen.getByRole("button", { name: "lab.project.saveDraft" }))
    expect(mockSaveProject).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "saved-project",
        name: "Saved selection",
        decisionPolicy: saved.decisionPolicy,
      })
    )

    const experimentPicker = await screen.findByLabelText("lab.project.experiments")
    await user.selectOptions(experimentPicker, "completed-experiment")
    await waitFor(() => {
      expect(mockServiceStatus).toHaveBeenCalledWith("completed-experiment")
      expect(mockLatestApplication).toHaveBeenCalledWith("completed-experiment")
    })
    expect(screen.getByText("lab.review.title")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "lab.steps.goal" }))
    await user.selectOptions(screen.getByLabelText("lab.project.saved"), "")
    expect(screen.getByLabelText("lab.project.name")).toHaveValue("")
    expect(screen.getByRole("button", { name: "lab.mode.model" })).toHaveAttribute(
      "aria-pressed",
      "true"
    )
    expect(screen.queryByLabelText("lab.project.experiments")).not.toBeInTheDocument()
  })
})
