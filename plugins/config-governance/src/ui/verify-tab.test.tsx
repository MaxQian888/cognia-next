/**
 * @jest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { registerPluginI18n, unregisterPluginI18n } from "@cognia/plugin-sdk/api/i18n"

import manifestJson from "../../plugin.json"
import { PLUGIN_ID } from "../model"

const EN = manifestJson.i18n.locales.en as Record<string, string>

beforeAll(() => {
  const locales = manifestJson.i18n.locales as Record<string, Record<string, string>>
  registerPluginI18n({
    pluginId: PLUGIN_ID,
    messages: Object.fromEntries(
      Object.entries(locales).map(([locale, dict]) => [
        locale,
        Object.fromEntries(
          Object.entries(dict).map(([key, value]) => [`plugin.${PLUGIN_ID}.${key}`, value])
        ),
      ])
    ),
  })
})
afterAll(() => unregisterPluginI18n(PLUGIN_ID))
afterEach(cleanup)

import type { GovernanceRuntime } from "../runtime/runtime"
import type { GovernanceData } from "./use-governance"
import { VerifyTab } from "./verify-tab"

function emptyData(partial: Partial<GovernanceData> = {}): GovernanceData {
  return {
    findings: [],
    kept: new Set(),
    results: new Map(),
    checksById: new Map(),
    rules: [],
    applied: [],
    evals: [],
    history: [],
    falseMatches: new Set(),
    ...partial,
  }
}

function runtime(datasets: Array<{ id: string; name: string }> = [{ id: "d", name: "Dataset" }]) {
  return {
    targetModel: jest.fn(() => "model-a"),
    evalDatasets: jest.fn(async () => datasets),
    compareSinceChange: jest.fn(async () => [
      {
        checkId: "C",
        before: 0.2,
        after: 0.8,
        beforeOpportunities: 5,
        afterOpportunities: 5,
        direction: "better",
      },
    ]),
    runEval: jest.fn(async () => ({})),
  } as unknown as GovernanceRuntime & Record<string, jest.Mock>
}

const change = {
  id: "ch",
  at: 0,
  workspaceId: "w",
  surfaceKey: "k",
  resultKey: "k",
  surfaceName: "CLAUDE.md",
  findingIds: [],
  hunks: 2,
}

describe("VerifyTab", () => {
  it("says when there is nothing to verify", async () => {
    render(<VerifyTab runtime={runtime([])} workspaceId={null} data={emptyData()} busy={false} />)
    expect(screen.getByText(EN["verify.noChanges"]!)).toBeTruthy()
    expect(screen.getByText(EN["verify.evalNeedsWorkspace"]!)).toBeTruthy()
    expect(await screen.findByText(EN["verify.noDatasets"]!)).toBeTruthy()
  })

  it("compares adherence around an applied change", async () => {
    const rt = runtime()
    render(
      <VerifyTab
        runtime={rt}
        workspaceId="w"
        data={emptyData({
          applied: [change],
          checks: { derivedAt: 0, checks: [], notCheckable: 0, rejected: 0 },
        })}
        busy={false}
      />
    )
    expect(screen.getByText("2 change(s)")).toBeTruthy()
    fireEvent.click(screen.getByText("Compare"))
    await waitFor(() => expect(rt.compareSinceChange).toHaveBeenCalledWith("ch"))
    expect(await screen.findByText("Better")).toBeTruthy()
    expect(screen.getByText("20% → 80% (5 → 5 times)")).toBeTruthy()
  })

  it("runs a baseline and a candidate eval with the target model, and shows comparisons", async () => {
    const rt = runtime()
    render(
      <VerifyTab
        runtime={rt}
        workspaceId="w"
        data={emptyData({
          evals: [
            {
              id: "b",
              at: 1,
              workspaceId: "w",
              role: "baseline",
              datasetId: "d",
              model: "model-a",
              runIds: [],
              passAt1: 0.5,
            },
            {
              id: "c",
              at: 2,
              workspaceId: "w",
              role: "candidate",
              datasetId: "d",
              model: "model-a",
              runIds: [],
              passAt1: 0.4,
            },
          ],
        })}
        busy={false}
      />
    )
    await waitFor(() =>
      expect(
        (screen.getByText("Run baseline").closest("button") as HTMLButtonElement).disabled
      ).toBe(false)
    )
    fireEvent.click(screen.getByText("Run baseline"))
    expect(rt.runEval).toHaveBeenCalledWith({
      role: "baseline",
      workspaceId: "w",
      datasetId: "d",
      model: "model-a",
    })
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: " model-b " } })
    fireEvent.click(screen.getByText("Run candidate"))
    expect(rt.runEval).toHaveBeenLastCalledWith({
      role: "candidate",
      workspaceId: "w",
      datasetId: "d",
      model: "model-b",
    })
    expect(screen.getByTestId("governance-eval-comparisons").textContent).toContain(
      "pass@1 50% → 40%"
    )
    expect(screen.getByText("Worse")).toBeTruthy()
  })
})
