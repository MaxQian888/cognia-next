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

import type { RuleCheck } from "../adherence/checks"
import type { GovernanceRuntime } from "../runtime/runtime"
import { AdherenceTab } from "./adherence-tab"
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

const check: RuleCheck = {
  id: "C",
  kind: "require-after",
  trigger: { family: "edit" },
  expect: { family: "shell", command: "^pnpm test" },
  scope: "turn",
  summary: "Tests after edits",
  rule: {
    surfaceKey: "k",
    surfaceName: "CLAUDE.md",
    startLine: 4,
    endLine: 4,
    text: "Run tests after edits.",
  },
}

const result = {
  checkId: "C",
  sessionsScanned: 6,
  sessionsTriggered: 3,
  opportunities: 5,
  followed: 1,
  violated: 4,
  excluded: 1,
  samples: [
    {
      sessionId: "s",
      messageId: "m",
      turn: 2,
      order: 7,
      outcome: "violated" as const,
      call: "src/a.ts",
    },
  ],
  dilution: { early: 0, late: 0.8, earlyOpportunities: 3, lateOpportunities: 3 },
}

function runtime() {
  return {
    deriveChecks: jest.fn(async () => ({})),
    backtest: jest.fn(async () => ({})),
    adopt: jest.fn(async () => ({})),
    setFalseMatch: jest.fn(async () => {}),
    clearFalseMatches: jest.fn(async () => {}),
  } as unknown as GovernanceRuntime & Record<string, jest.Mock>
}

describe("AdherenceTab", () => {
  it("offers to derive checks first", () => {
    const rt = runtime()
    render(<AdherenceTab runtime={rt} workspaceId="w" data={emptyData()} busy={false} />)
    expect(screen.getByText(EN["adherence.none"]!)).toBeTruthy()
    expect(
      (screen.getByText("Replay sessions").closest("button") as HTMLButtonElement).disabled
    ).toBe(true)
    fireEvent.click(screen.getByText("Derive checks"))
    expect(rt.deriveChecks).toHaveBeenCalledWith("w")
  })

  it("shows each check's verdict, rate, dilution and samples, and labels a false match", async () => {
    const rt = runtime()
    render(
      <AdherenceTab
        runtime={rt}
        workspaceId="w"
        data={emptyData({
          checks: { derivedAt: 0, checks: [check], notCheckable: 2, rejected: 1 },
          adherence: { ranAt: 0, sessions: 6, results: [result] },
          results: new Map([["C", result]]),
          falseMatches: new Set(["x"]),
        })}
        busy={false}
      />
    )
    expect(screen.getByText("Not followed")).toBeTruthy()
    expect(screen.getByText(/Followed 20% \(1\/5\) · applied in 3 of 6 sessions/)).toBeTruthy()
    expect(
      screen.getByText(/Breaks more often late in long sessions: 0% early vs 80% late/)
    ).toBeTruthy()
    expect(screen.getByText(/2 rules not checkable · 1 rejected/)).toBeTruthy()
    fireEvent.click(screen.getByText("Replay sessions"))
    expect(rt.backtest).toHaveBeenCalledWith("w")
    fireEvent.click(screen.getByText("Show samples (1)"))
    expect(screen.getByTestId("governance-samples").textContent).toContain("src/a.ts")
    fireEvent.click(screen.getByText("Not a match"))
    await waitFor(() => expect(rt.setFalseMatch).toHaveBeenCalledWith("C", "s", 7, true))
    fireEvent.click(screen.getByText("Clear false-match labels"))
    expect(rt.clearFalseMatches).toHaveBeenCalledWith("C")
    fireEvent.click(screen.getByText("Enforce: remind"))
    expect(rt.adopt).toHaveBeenCalledWith(check, "remind", "w")
  })

  it("marks checks that are already enforced", () => {
    render(
      <AdherenceTab
        runtime={runtime()}
        workspaceId="w"
        data={emptyData({
          checks: { derivedAt: 0, checks: [check], notCheckable: 0, rejected: 0 },
          rules: [{ id: "E", check, mode: "block", workspaceId: "w", enabled: true, createdAt: 0 }],
        })}
        busy={false}
      />
    )
    expect(screen.getByText("Enforced")).toBeTruthy()
    expect(screen.queryByText("Enforce: block")).toBeNull()
  })
})
