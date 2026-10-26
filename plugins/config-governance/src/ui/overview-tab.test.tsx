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

import type { AuditRun } from "../model"
import type { GovernanceRuntime } from "../runtime/runtime"
import { OverviewTab, summarizeNotes } from "./overview-tab"
import type { GovernanceData } from "./use-governance"

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

const run: AuditRun = {
  id: "r",
  workspaceId: "w",
  startedAt: 0,
  finishedAt: 0,
  targetModel: "old-model",
  surfaces: [],
  findings: [],
  hunks: [],
  failedSources: ["character"],
  notes: ["surfaces-capped:4", "judge-failed:a:x", "judge-failed:b:y"],
}

const runtime = () =>
  ({
    audit: jest.fn(async () => ({})),
    targetModel: jest.fn(() => "new-model"),
  }) as unknown as GovernanceRuntime & Record<string, jest.Mock>

describe("summarizeNotes", () => {
  it("counts notes by kind and reads capped counts from their payload", () => {
    expect(summarizeNotes(run.notes)).toEqual([
      { key: "notes.surfaces-capped", count: 4 },
      { key: "notes.judge-failed", count: 2 },
    ])
  })
})

describe("OverviewTab", () => {
  it("invites the first audit", () => {
    const rt = runtime()
    render(<OverviewTab runtime={rt} workspaceId="w" data={emptyData()} busy={false} />)
    expect(screen.getByText(EN["overview.never"]!)).toBeTruthy()
    fireEvent.click(screen.getByText("Run audit"))
    expect(rt.audit).toHaveBeenCalledWith("w")
  })

  it("summarizes the last run, the model change, notes and history", async () => {
    render(
      <OverviewTab
        runtime={runtime()}
        workspaceId="w"
        data={emptyData({
          run,
          modelChangedFrom: "old-model",
          findings: [
            {
              id: "a",
              group: "hygiene",
              pattern: "p",
              location: { surfaceKey: "k" },
              evidence: "",
              reason: "",
              confidence: "low",
              action: "flag",
              sources: [],
            },
            {
              id: "kept",
              group: "hygiene",
              pattern: "p",
              location: { surfaceKey: "k" },
              evidence: "",
              reason: "",
              confidence: "low",
              action: "flag",
              sources: [],
            },
          ],
          kept: new Set(["kept"]),
          history: [
            {
              runId: "1",
              at: 0,
              targetModel: "m",
              counts: {
                "brittle-config": 1,
                adherence: 0,
                "dated-text": 2,
                descriptions: 0,
                hygiene: 0,
              },
              high: 1,
              surfaces: 1,
            },
            {
              runId: "2",
              at: 0,
              targetModel: "m",
              counts: {
                "brittle-config": 0,
                adherence: 0,
                "dated-text": 0,
                descriptions: 0,
                hygiene: 0,
              },
              high: 0,
              surfaces: 1,
            },
          ],
        })}
        busy={false}
      />
    )
    expect(screen.getByTestId("governance-model-changed").textContent).toContain("old-model")
    expect(screen.getByTestId("governance-model-changed").textContent).toContain("new-model")
    expect(screen.getByText("Run audit again")).toBeTruthy()
    const hygiene = screen.getByText("Hygiene").parentElement!
    expect(hygiene.textContent).toContain("1")
    expect(screen.getByText("Could not read: character")).toBeTruthy()
    expect(screen.getByTestId("governance-notes").textContent).toContain(
      "4 more surfaces were over the limit"
    )
    expect(screen.getByText("3 finding(s)")).toBeTruthy()
    await waitFor(() => expect(screen.getByText("1 high")).toBeTruthy())
  })
})
