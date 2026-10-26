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
import { EnforcementTab } from "./enforcement-tab"
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

describe("EnforcementTab", () => {
  it("says when there are no rules and when enforcement is off", () => {
    render(
      <EnforcementTab
        runtime={{} as GovernanceRuntime}
        data={emptyData()}
        workspaces={[]}
        enforcementEnabled={false}
      />
    )
    expect(screen.getByText(EN["enforcement.none"]!)).toBeTruthy()
    expect(screen.getByText(EN["enforcement.disabledBySetting"]!)).toBeTruthy()
  })

  it("lists rules with their scope and lets the user toggle and remove them", async () => {
    const runtime = {
      updateRule: jest.fn(async () => {}),
      removeRule: jest.fn(async () => {}),
    } as unknown as GovernanceRuntime & Record<string, jest.Mock>
    render(
      <EnforcementTab
        runtime={runtime}
        data={emptyData({
          rules: [
            { id: "A", check, mode: "block", workspaceId: "w", enabled: true, createdAt: 0 },
            {
              id: "B",
              check: { ...check, id: "C2", trigger: { family: "shell", command: "(" } },
              mode: "remind",
              workspaceId: null,
              enabled: false,
              createdAt: 0,
            },
          ],
        })}
        workspaces={[{ id: "w", name: "Repo", roots: [] }]}
        enforcementEnabled
      />
    )
    expect(screen.getByText("Repo")).toBeTruthy()
    expect(screen.getByText("Every session")).toBeTruthy()
    expect(screen.getByText("Invalid")).toBeTruthy()
    expect(screen.getByText(EN["enforcement.afterAlwaysReminds"]!)).toBeTruthy()
    fireEvent.click(screen.getAllByRole("switch")[0]!)
    await waitFor(() => expect(runtime.updateRule).toHaveBeenCalledWith("A", { enabled: false }))
    fireEvent.click(screen.getAllByText("Remove")[1]!)
    expect(runtime.removeRule).toHaveBeenCalledWith("B")
  })
})
