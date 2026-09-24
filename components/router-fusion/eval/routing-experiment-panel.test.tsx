/**
 * @jest-environment jsdom
 */

import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import {
  runRecordedRoutingExperiment,
  runSimulatedRoutingExperiment,
  type RoutingEvalWorkspace,
  type RoutingExperimentResult,
  type RoutingSampleExport,
  type ShadowRunOutcome,
} from "@/lib/ai/eval/routing-experiment"
import type { FusionPredictorManifestRow } from "@/lib/router-fusion/db/types"
import { buildRoutingSampleExport } from "@/lib/router-fusion/eval/routing-sample"
import { simulatedRoutingSamples } from "@/lib/router-fusion/eval/simulated-samples"
import { useSettingsStore } from "@/stores/settings"

import { ROUTING_EXPERIMENT_SEED, RoutingExperimentPanel } from "./routing-experiment-panel"

const CREATED_AT = "2026-03-01T00:00:00.000Z"
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const ACTION_BUTTONS = [
  "Collect samples",
  "Export samples",
  "Run simulated",
  "Run on collected samples",
  "Record shadow decisions",
]

const ON_SETTINGS = { routerFusion: { enabled: true, surfaces: { chat: true } } }
const OFF_SETTINGS = { routerFusion: { enabled: true, surfaces: { chat: false } } }

const SHA_A = `${"a".repeat(16)}${"1".repeat(48)}`
const SHA_B = `${"b".repeat(16)}${"2".repeat(48)}`

const SAMPLES = simulatedRoutingSamples({ seed: 1, sessionCount: 3 })

let liveResult: RoutingExperimentResult

beforeAll(async () => {
  liveResult = await runRecordedRoutingExperiment(
    simulatedRoutingSamples({ seed: 11 }).map((row) => ({ ...row, origin: "recorded" as const })),
    { seed: ROUTING_EXPERIMENT_SEED, createdAt: CREATED_AT, iterations: 20 }
  )
})

function setSettings(settings: unknown) {
  act(() => {
    useSettingsStore.setState({ settings: settings as never })
  })
}

function manifestRow(manifestSha256: string): FusionPredictorManifestRow {
  return {
    manifestSha256,
    kind: "published",
    active: 1,
    featuresVersion: "router-fusion-features/1",
    manifest: {},
    previousManifestSha256: null,
    gateVerdict: "pass",
    gateReasons: [],
    label: "live",
    activatedAt: 1,
    deactivatedAt: null,
    createdAt: 1,
  }
}

function sampleExport(count = 4): RoutingSampleExport {
  return buildRoutingSampleExport(
    SAMPLES.slice(0, count).map((row) => ({ ...row, origin: "recorded" as const })),
    { exportedAt: CREATED_AT }
  )
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** jsdom's Blob has no `text()`; FileReader is the portable read. */
function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsText(blob)
  })
}

function fakeWorkspace(over: Partial<RoutingEvalWorkspace> = {}) {
  return {
    collect: jest.fn<ReturnType<RoutingEvalWorkspace["collect"]>, []>(async () => ({
      scanned: 5,
      collected: 2,
      skipped: [],
    })),
    listSamples: jest.fn<ReturnType<RoutingEvalWorkspace["listSamples"]>, []>(async () => []),
    exportSamples: jest.fn<ReturnType<RoutingEvalWorkspace["exportSamples"]>, []>(async () =>
      sampleExport()
    ),
    runExperiment: jest.fn<
      ReturnType<RoutingEvalWorkspace["runExperiment"]>,
      Parameters<RoutingEvalWorkspace["runExperiment"]>
    >(async () => liveResult),
    shadow: jest.fn<ReturnType<RoutingEvalWorkspace["shadow"]>, []>(async () => ({
      status: "no_predictor" as const,
    })),
    listShadowDecisions: jest.fn<ReturnType<RoutingEvalWorkspace["listShadowDecisions"]>, []>(
      async () => []
    ),
    activeManifest: jest.fn<ReturnType<RoutingEvalWorkspace["activeManifest"]>, []>(
      async () => undefined
    ),
    listManifests: jest.fn<ReturnType<RoutingEvalWorkspace["listManifests"]>, []>(async () => []),
    promote: jest.fn<
      ReturnType<RoutingEvalWorkspace["promote"]>,
      Parameters<RoutingEvalWorkspace["promote"]>
    >(async () => ({ status: "refused", refusals: ["GATE_NOT_PASSED"] })),
    rollback: jest.fn<
      ReturnType<RoutingEvalWorkspace["rollback"]>,
      Parameters<RoutingEvalWorkspace["rollback"]>
    >(async () => ({ status: "deactivated", row: null })),
    ...over,
  }
}

type FakeWorkspace = ReturnType<typeof fakeWorkspace>

function renderPanel(
  workspace: FakeWorkspace,
  props: Partial<React.ComponentProps<typeof RoutingExperimentPanel>> = {}
) {
  const openWorkspace = jest.fn(async (_settings: unknown) => workspace as RoutingEvalWorkspace)
  const user = userEvent.setup()
  const view = render(<RoutingExperimentPanel openWorkspace={openWorkspace} {...props} />)
  return { ...view, openWorkspace, user }
}

/** The mount-time load has finished once the active manifest has been read and rendered. */
async function loaded(workspace: FakeWorkspace) {
  await waitFor(() => expect(workspace.activeManifest).toHaveBeenCalled())
  await waitFor(() => expect(screen.queryByText("Working…")).not.toBeInTheDocument())
}

const button = (name: string) => screen.getByRole("button", { name })
const activePredictor = () => screen.getByTestId("routing-active-predictor")
const notice = () => screen.getByTestId("routing-experiment-notice")

beforeEach(() => {
  setSettings(ON_SETTINGS)
})

afterEach(() => {
  setSettings(null)
})

describe("RoutingExperimentPanel — off", () => {
  it("renders only the off card and never opens the workspace while every surface is off", () => {
    setSettings(OFF_SETTINGS)
    const workspace = fakeWorkspace()
    const { openWorkspace } = renderPanel(workspace)

    const card = screen.getByTestId("routing-experiment-unavailable")
    expect(card).toHaveTextContent("Router + Fusion is off")
    expect(card).toHaveTextContent(
      "Turn on a Router + Fusion surface under Settings → AI connections → Routing."
    )
    expect(screen.queryByTestId("routing-experiment-panel")).not.toBeInTheDocument()
    expect(screen.queryAllByRole("button")).toHaveLength(0)
    expect(openWorkspace).not.toHaveBeenCalled()
  })

  it("renders the off card when no settings are loaded", () => {
    setSettings(null)
    const { openWorkspace } = renderPanel(fakeWorkspace())
    expect(screen.getByTestId("routing-experiment-unavailable")).toBeInTheDocument()
    expect(openWorkspace).not.toHaveBeenCalled()
  })

  it("opens the workspace with the current settings once a surface is turned on", async () => {
    setSettings(OFF_SETTINGS)
    const workspace = fakeWorkspace({ listSamples: jest.fn(async () => SAMPLES.slice(0, 2)) })
    const { openWorkspace } = renderPanel(workspace)
    expect(openWorkspace).not.toHaveBeenCalled()

    setSettings(ON_SETTINGS)

    expect(await screen.findByText("2 stored")).toBeInTheDocument()
    expect(screen.getByTestId("routing-experiment-panel")).toBeInTheDocument()
    expect(openWorkspace).toHaveBeenCalledWith(ON_SETTINGS)
  })
})

describe("RoutingExperimentPanel — on", () => {
  it("loads the stored sample count and the active predictor on mount", async () => {
    const workspace = fakeWorkspace({
      listSamples: jest.fn(async () => SAMPLES.slice(0, 3)),
      activeManifest: jest.fn(async () => manifestRow(SHA_A)),
    })
    const { openWorkspace } = renderPanel(workspace)

    expect(await screen.findByText("3 stored")).toBeInTheDocument()
    expect(activePredictor()).toHaveTextContent(SHA_A.slice(0, 16))
    expect(activePredictor()).not.toHaveTextContent(SHA_A)
    expect(openWorkspace).toHaveBeenCalledTimes(1)
    expect(openWorkspace).toHaveBeenCalledWith(ON_SETTINGS)
    expect(screen.getByText("Routing experiment")).toBeInTheDocument()
    expect(screen.getByText("No experiment has been run yet.")).toBeInTheDocument()
    expect(screen.getByText("No shadow decision has been recorded yet.")).toBeInTheDocument()
    for (const name of ACTION_BUTTONS) expect(button(name)).toBeEnabled()
    // Nothing to promote until an experiment ran; something to roll back to.
    expect(button("Promote")).toBeDisabled()
    expect(button("Roll back")).toBeEnabled()
  })

  it("says the rules router decides every route when no predictor is active", async () => {
    const workspace = fakeWorkspace()
    renderPanel(workspace)
    await loaded(workspace)

    expect(screen.getByText("0 stored")).toBeInTheDocument()
    expect(activePredictor()).toHaveTextContent("None — the rules router decides every route.")
    expect(button("Roll back")).toBeDisabled()
  })

  it("[ROLE 7] labels promotion as not yet changing a routing decision", async () => {
    const workspace = fakeWorkspace({ activeManifest: jest.fn(async () => manifestRow(SHA_A)) })
    renderPanel(workspace)
    await loaded(workspace)

    const note = screen.getByTestId("routing-promotion-dormancy")
    expect(note).toBeVisible()
    expect(note).toHaveTextContent(
      "Later release: a promoted predictor is recorded and shadowed, and does not change a routing decision yet."
    )
    const promotionCard = note.parentElement!
    expect(within(promotionCard).getByRole("button", { name: "Promote" })).toBeInTheDocument()
  })

  it("reports a workspace that fails to open on mount", async () => {
    const openWorkspace = jest.fn(async () => {
      throw new Error("fusion database unavailable")
    })
    render(<RoutingExperimentPanel openWorkspace={openWorkspace} />)

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The routing experiment failed: fusion database unavailable"
    )
  })

  it("reports a non-Error failure by its string form", async () => {
    const workspace = fakeWorkspace({
      listSamples: jest.fn(() => Promise.reject("vault locked")),
    })
    renderPanel(workspace)

    expect(await screen.findByTestId("routing-experiment-error")).toHaveTextContent(
      "The routing experiment failed: vault locked"
    )
  })

  it("ignores a mount-time load that finishes after the panel was switched off and on again", async () => {
    const stale = deferred<Awaited<ReturnType<RoutingEvalWorkspace["listSamples"]>>>()
    const first = fakeWorkspace({ listSamples: jest.fn(() => stale.promise) })
    const second = fakeWorkspace({ listSamples: jest.fn(async () => SAMPLES.slice(0, 3)) })
    const openWorkspace = jest
      .fn<Promise<RoutingEvalWorkspace>, [unknown]>()
      .mockResolvedValueOnce(first as RoutingEvalWorkspace)
      .mockResolvedValueOnce(second as RoutingEvalWorkspace)
    render(<RoutingExperimentPanel openWorkspace={openWorkspace} />)
    await waitFor(() => expect(first.listSamples).toHaveBeenCalled())

    setSettings(OFF_SETTINGS)
    setSettings(ON_SETTINGS)
    expect(await screen.findByText("3 stored")).toBeInTheDocument()

    await act(async () => {
      stale.resolve(SAMPLES)
      await stale.promise
    })
    expect(screen.getByText("3 stored")).toBeInTheDocument()
    expect(screen.queryByText(`${SAMPLES.length} stored`)).not.toBeInTheDocument()
    expect(openWorkspace).toHaveBeenCalledTimes(2)
  })

  it("does not report a mount-time failure that lands after the panel was switched off", async () => {
    const failing = deferred<Awaited<ReturnType<RoutingEvalWorkspace["listSamples"]>>>()
    const listSamples = jest
      .fn<ReturnType<RoutingEvalWorkspace["listSamples"]>, []>()
      .mockImplementationOnce(() => failing.promise)
      .mockResolvedValue(SAMPLES.slice(0, 1))
    const workspace = fakeWorkspace({ listSamples })
    renderPanel(workspace)
    await waitFor(() => expect(workspace.listSamples).toHaveBeenCalled())

    setSettings(OFF_SETTINGS)
    await act(async () => {
      failing.reject(new Error("too late"))
      await failing.promise.catch(() => undefined)
    })
    setSettings(ON_SETTINGS)

    expect(await screen.findByText("1 stored")).toBeInTheDocument()
    expect(listSamples).toHaveBeenCalledTimes(2)
    expect(screen.queryByText(/too late/)).not.toBeInTheDocument()
  })

  it("collects samples while showing it is busy, then refreshes the count", async () => {
    const pending = deferred<Awaited<ReturnType<RoutingEvalWorkspace["collect"]>>>()
    const listSamples = jest
      .fn<ReturnType<RoutingEvalWorkspace["listSamples"]>, []>()
      .mockResolvedValueOnce([])
      .mockResolvedValue(SAMPLES.slice(0, 2))
    const workspace = fakeWorkspace({ collect: jest.fn(() => pending.promise), listSamples })
    const { openWorkspace, user } = renderPanel(workspace)
    await loaded(workspace)

    await user.click(button("Collect samples"))

    expect(screen.getByText("Working…")).toHaveAttribute("role", "status")
    for (const name of ACTION_BUTTONS) expect(button(name)).toBeDisabled()
    expect(openWorkspace).toHaveBeenLastCalledWith(ON_SETTINGS)

    await act(async () => {
      pending.resolve({
        scanned: 5,
        collected: 2,
        skipped: [{ runId: "run-1", reason: "cost_pending" }],
      })
    })

    expect(await screen.findByText("Collected 2 of 5 runs")).toBeInTheDocument()
    expect(screen.getByText("2 stored")).toBeInTheDocument()
    expect(screen.queryByText("Working…")).not.toBeInTheDocument()
    for (const name of ACTION_BUTTONS) expect(button(name)).toBeEnabled()
  })

  it("hands the export to the injected sink and says how many samples went", async () => {
    const document = sampleExport(4)
    const workspace = fakeWorkspace({ exportSamples: jest.fn(async () => document) })
    const onExport = jest.fn<Promise<void>, [RoutingSampleExport]>(async () => {})
    const { user } = renderPanel(workspace, { onExport })
    await loaded(workspace)

    await user.click(button("Export samples"))

    expect(await screen.findByText("Exported 4 samples with their propensity")).toBeInTheDocument()
    expect(onExport).toHaveBeenCalledWith(document)
  })

  it("downloads the export as a JSON file by default", async () => {
    const document_ = sampleExport(2)
    const workspace = fakeWorkspace({ exportSamples: jest.fn(async () => document_) })
    const blobs: Blob[] = []
    const clicked: Array<{ href: string; download: string }> = []
    const originalCreate = URL.createObjectURL
    const originalRevoke = URL.revokeObjectURL
    URL.createObjectURL = jest.fn((blob: Blob) => {
      blobs.push(blob)
      return "blob:routing-samples"
    })
    URL.revokeObjectURL = jest.fn()
    const click = jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement
    ) {
      clicked.push({ href: this.href, download: this.download })
    })
    try {
      const { user } = renderPanel(workspace)
      await loaded(workspace)

      await user.click(button("Export samples"))

      expect(
        await screen.findByText("Exported 2 samples with their propensity")
      ).toBeInTheDocument()
      expect(clicked).toEqual([
        { href: "blob:routing-samples", download: "routing-samples-live.json" },
      ])
      expect(blobs).toHaveLength(1)
      expect(blobs[0].type).toBe("application/json")
      expect(await readBlob(blobs[0])).toBe(JSON.stringify(document_, null, 2))
      expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:routing-samples")
    } finally {
      click.mockRestore()
      URL.createObjectURL = originalCreate
      URL.revokeObjectURL = originalRevoke
    }
  })

  it("reports a failed export and returns the buttons", async () => {
    const workspace = fakeWorkspace()
    const onExport = jest.fn(async () => {
      throw new Error("disk full")
    })
    const { user } = renderPanel(workspace, { onExport })
    await loaded(workspace)

    await user.click(button("Export samples"))

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The routing experiment failed: disk full"
    )
    expect(screen.queryByTestId("routing-experiment-notice")).not.toBeInTheDocument()
    for (const name of ACTION_BUTTONS) expect(button(name)).toBeEnabled()
  })

  it("clears an earlier error once the next action succeeds", async () => {
    const workspace = fakeWorkspace()
    const openWorkspace = jest
      .fn<Promise<RoutingEvalWorkspace>, [unknown]>()
      .mockResolvedValueOnce(workspace as RoutingEvalWorkspace)
      .mockRejectedValueOnce(new Error("vault locked"))
      .mockResolvedValue(workspace as RoutingEvalWorkspace)
    const user = userEvent.setup()
    render(<RoutingExperimentPanel openWorkspace={openWorkspace} />)
    await loaded(workspace)

    await user.click(button("Collect samples"))
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The routing experiment failed: vault locked"
    )
    expect(workspace.collect).not.toHaveBeenCalled()

    await user.click(button("Collect samples"))
    expect(await screen.findByText("Collected 2 of 5 runs")).toBeInTheDocument()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("runs the simulated experiment with the fixed seed and shows it as a rehearsal", async () => {
    const runSimulated = jest.fn((options: Parameters<typeof runSimulatedRoutingExperiment>[0]) =>
      runSimulatedRoutingExperiment({ ...options, iterations: 20 })
    )
    const workspace = fakeWorkspace()
    const { user } = renderPanel(workspace, { runSimulated })
    await loaded(workspace)

    await user.click(button("Collect samples"))
    expect(await screen.findByText("Collected 2 of 5 runs")).toBeInTheDocument()

    await user.click(button("Run simulated"))

    const summary = await screen.findByTestId("routing-report-summary")
    expect(within(summary).getByText("Simulated")).toBeInTheDocument()
    expect(within(summary).getByTestId("routing-report-claim")).toHaveTextContent(
      "This report makes no claim about real quality, cost or saving."
    )
    expect(ROUTING_EXPERIMENT_SEED).toBe(1)
    expect(runSimulated).toHaveBeenCalledWith({
      seed: ROUTING_EXPERIMENT_SEED,
      createdAt: expect.stringMatching(ISO_TIMESTAMP),
    })
    // A fresh run replaces the previous action's notice.
    expect(screen.queryByTestId("routing-experiment-notice")).not.toBeInTheDocument()
    expect(screen.queryByText("No experiment has been run yet.")).not.toBeInTheDocument()
    expect(button("Promote")).toBeEnabled()
    // The simulated path needs no database.
    expect(workspace.runExperiment).not.toHaveBeenCalled()
  })

  it("reports a simulated run that fails and keeps promotion disabled", async () => {
    const runSimulated = jest.fn(async () => {
      throw new Error("sessionCount must be a positive integer")
    })
    const workspace = fakeWorkspace()
    const { user } = renderPanel(workspace, { runSimulated })
    await loaded(workspace)

    await user.click(button("Run simulated"))

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The routing experiment failed: sessionCount must be a positive integer"
    )
    expect(screen.getByText("No experiment has been run yet.")).toBeInTheDocument()
    expect(button("Promote")).toBeDisabled()
    for (const name of ACTION_BUTTONS) expect(button(name)).toBeEnabled()
  })

  it("reports a simulated run that fails with a non-Error value", async () => {
    const runSimulated = jest.fn(() => Promise.reject(42))
    const workspace = fakeWorkspace()
    const { user } = renderPanel(workspace, { runSimulated })
    await loaded(workspace)

    await user.click(button("Run simulated"))

    expect(await screen.findByRole("alert")).toHaveTextContent("The routing experiment failed: 42")
  })

  it("shows every reason a promotion was refused", async () => {
    let simulated: RoutingExperimentResult | null = null
    const runSimulated = jest.fn(
      async (options: Parameters<typeof runSimulatedRoutingExperiment>[0]) => {
        simulated = await runSimulatedRoutingExperiment({ ...options, iterations: 20 })
        return simulated
      }
    )
    const workspace = fakeWorkspace({
      promote: jest.fn(async () => ({
        status: "refused" as const,
        refusals: ["SIMULATED_REPORT" as const, "GATE_NOT_PASSED" as const],
      })),
    })
    const { user } = renderPanel(workspace, { runSimulated })
    await loaded(workspace)
    await user.click(button("Run simulated"))
    await screen.findByTestId("routing-report-summary")

    await user.click(button("Promote"))

    await waitFor(() =>
      expect(notice()).toHaveTextContent(
        "A simulated report never promotes anything: it met no real request and spent no real money. The promotion gate did not pass."
      )
    )
    expect(workspace.promote).toHaveBeenCalledWith(simulated)
    expect(activePredictor()).toHaveTextContent("None — the rules router decides every route.")
    expect(workspace.activeManifest).toHaveBeenCalledTimes(1)
  })

  it("runs on collected samples with the fixed seed and shows the live report", async () => {
    const workspace = fakeWorkspace()
    const { user } = renderPanel(workspace)
    await loaded(workspace)

    await user.click(button("Run on collected samples"))

    const summary = await screen.findByTestId("routing-report-summary")
    expect(within(summary).getByText("Live")).toBeInTheDocument()
    expect(workspace.runExperiment).toHaveBeenCalledWith({
      seed: ROUTING_EXPERIMENT_SEED,
      createdAt: expect.stringMatching(ISO_TIMESTAMP),
    })
    expect(button("Promote")).toBeEnabled()
  })

  it("promotes, then rolls back through the apply record before falling back to the registry", async () => {
    const activeManifest = jest
      .fn<ReturnType<RoutingEvalWorkspace["activeManifest"]>, []>()
      .mockResolvedValueOnce(undefined) // mount
      .mockResolvedValueOnce(manifestRow(SHA_B)) // after promote
      .mockResolvedValueOnce(manifestRow(SHA_A)) // after the first rollback
      .mockResolvedValueOnce(undefined) // after the second rollback
    const rollback = jest
      .fn<
        ReturnType<RoutingEvalWorkspace["rollback"]>,
        Parameters<RoutingEvalWorkspace["rollback"]>
      >()
      .mockResolvedValueOnce({ status: "rolled_back", row: manifestRow(SHA_A) })
      .mockResolvedValueOnce({ status: "deactivated", row: manifestRow(SHA_A) })
    const workspace = fakeWorkspace({
      activeManifest,
      rollback,
      promote: jest.fn(async () => ({
        status: "promoted" as const,
        manifestSha256: SHA_B,
        applicationId: "apply-1",
      })),
    })
    const { user } = renderPanel(workspace)
    await loaded(workspace)
    await user.click(button("Run on collected samples"))
    await screen.findByTestId("routing-report-summary")

    await user.click(button("Promote"))
    await waitFor(() => expect(notice()).toHaveTextContent(`Promoted ${SHA_B.slice(0, 16)}`))
    expect(workspace.promote).toHaveBeenCalledWith(liveResult)
    expect(activePredictor()).toHaveTextContent(SHA_B.slice(0, 16))
    expect(button("Roll back")).toBeEnabled()

    await user.click(button("Roll back"))
    await waitFor(() => expect(notice()).toHaveTextContent("Restored the previous predictor"))
    expect(rollback).toHaveBeenNthCalledWith(1, "apply-1")
    expect(activePredictor()).toHaveTextContent(SHA_A.slice(0, 16))

    // The apply record is spent; the next step back moves the registry pointer itself.
    await user.click(button("Roll back"))
    await waitFor(() => expect(notice()).toHaveTextContent("The learned router is off again"))
    expect(rollback).toHaveBeenNthCalledWith(2, undefined)
    expect(activePredictor()).toHaveTextContent("None — the rules router decides every route.")
    expect(button("Roll back")).toBeDisabled()
  })

  it("forgets the apply record when a new experiment runs", async () => {
    const workspace = fakeWorkspace({
      activeManifest: jest
        .fn<ReturnType<RoutingEvalWorkspace["activeManifest"]>, []>()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValue(manifestRow(SHA_B)),
      promote: jest.fn(async () => ({
        status: "promoted" as const,
        manifestSha256: SHA_B,
        applicationId: "apply-1",
      })),
      rollback: jest.fn(async () => ({ status: "rolled_back" as const, row: manifestRow(SHA_A) })),
    })
    const { user } = renderPanel(workspace)
    await loaded(workspace)
    await user.click(button("Run on collected samples"))
    await screen.findByTestId("routing-report-summary")
    await user.click(button("Promote"))
    await waitFor(() => expect(notice()).toHaveTextContent(`Promoted ${SHA_B.slice(0, 16)}`))

    await user.click(button("Run on collected samples"))
    await waitFor(() =>
      expect(screen.queryByTestId("routing-experiment-notice")).not.toBeInTheDocument()
    )
    await user.click(button("Roll back"))

    await waitFor(() => expect(notice()).toHaveTextContent("Restored the previous predictor"))
    expect(workspace.rollback).toHaveBeenCalledWith(undefined)
  })

  it("shows the registry's own message when a rollback is refused", async () => {
    const workspace = fakeWorkspace({
      activeManifest: jest.fn(async () => manifestRow(SHA_A)),
      rollback: jest.fn(async () => ({
        status: "refused" as const,
        code: "NO_ACTIVE_MANIFEST" as const,
        message: "no learned router is active",
      })),
    })
    const { user } = renderPanel(workspace)
    await loaded(workspace)

    await user.click(button("Roll back"))

    await waitFor(() => expect(notice()).toHaveTextContent("no learned router is active"))
    expect(workspace.rollback).toHaveBeenCalledWith(undefined)
  })

  it.each<[string, ShadowRunOutcome, string]>([
    [
      "no predictor",
      { status: "no_predictor" },
      "No learned router is active, so there is nothing to shadow.",
    ],
    [
      "a refused predictor",
      { status: "predictor_refused", problems: ["seal mismatch"] },
      "The active manifest could not be verified and was not used.",
    ],
    [
      "no samples",
      { status: "no_samples", manifestSha256: SHA_A },
      "No shadow decision has been recorded yet.",
    ],
  ])("explains a shadow pass with %s", async (_case, outcome, text) => {
    const workspace = fakeWorkspace({ shadow: jest.fn(async () => outcome) })
    const { user } = renderPanel(workspace)
    await loaded(workspace)

    await user.click(button("Record shadow decisions"))

    await waitFor(() => expect(workspace.shadow).toHaveBeenCalledTimes(1))
    expect(await screen.findByText(text)).toBeInTheDocument()
    expect(screen.queryByTestId("routing-shadow-summary")).not.toBeInTheDocument()
  })

  it("summarizes recorded shadow decisions", async () => {
    const recorded = (agreementRate: number | null): ShadowRunOutcome => ({
      status: "recorded",
      manifestSha256: SHA_A,
      predictorVersion: "v1",
      stored: 10,
      summary: {
        evaluated: 10,
        agreed: 7,
        agreementRate,
        noOpinion: 1,
        outOfDistribution: 2,
        shadowActionCounts: { direct_economy: 9 },
      },
    })
    const workspace = fakeWorkspace({
      shadow: jest
        .fn<ReturnType<RoutingEvalWorkspace["shadow"]>, []>()
        .mockResolvedValueOnce(recorded(0.7))
        .mockResolvedValueOnce(recorded(null)),
    })
    const { user } = renderPanel(workspace)
    await loaded(workspace)

    await user.click(button("Record shadow decisions"))
    expect(await screen.findByTestId("routing-shadow-summary")).toHaveTextContent(
      "Evaluated: 10 · Agreement: 70.0% · Out of distribution: 2"
    )
    expect(screen.queryByText("No shadow decision has been recorded yet.")).not.toBeInTheDocument()

    await user.click(button("Record shadow decisions"))
    await waitFor(() =>
      expect(screen.getByTestId("routing-shadow-summary")).toHaveTextContent("Agreement: —")
    )
  })
})
