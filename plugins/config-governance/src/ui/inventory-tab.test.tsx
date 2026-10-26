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
import { InventoryTab } from "./inventory-tab"
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

function runtime(overrides: Record<string, unknown> = {}) {
  return {
    surfaces: jest.fn(async () => ({
      workspaceId: "w",
      failed: ["skill"],
      surfaces: [
        {
          key: "instruction-file:/r/CLAUDE.md",
          source: "instruction-file",
          name: "CLAUDE.md",
          builtIn: false,
          modified: false,
          loadOrder: 0,
          path: "/r/CLAUDE.md",
        },
        {
          key: "agent-file:/r/.claude/agents|reviewer.md",
          source: "agent-file",
          name: "reviewer.md",
          builtIn: false,
          modified: false,
        },
        { key: "code:shipped", source: "code", name: "shipped", builtIn: true, modified: true },
      ],
    })),
    facts: jest.fn(async () => ({
      hooksAvailable: false,
      hooks: [],
      permissionRules: [{}, {}],
      mcpServers: [{}],
      skills: { total: 4, enabled: 3, builtIn: 1 },
    })),
    audit: jest.fn(async () => ({})),
    openInPromptCenter: jest.fn(() => true),
    ...overrides,
  } as unknown as GovernanceRuntime & Record<string, jest.Mock>
}

describe("InventoryTab", () => {
  it("lists every surface with its owner, load order, state and findings", async () => {
    const rt = runtime()
    render(
      <InventoryTab
        runtime={rt}
        workspaceId="w"
        data={emptyData({
          findings: [
            {
              id: "F",
              group: "dated-text",
              pattern: "p",
              location: { surfaceKey: "instruction-file:/r/CLAUDE.md" },
              evidence: "",
              reason: "",
              confidence: "low",
              action: "flag",
              sources: [],
            },
          ],
          run: {
            id: "r",
            workspaceId: "w",
            startedAt: 0,
            finishedAt: 0,
            targetModel: "m",
            surfaces: [
              {
                surface: { key: "code:shipped" } as never,
                textHash: "",
                lineCount: 0,
                skipped: "withheld",
              },
            ],
            findings: [],
            hunks: [],
            failedSources: [],
            notes: [],
          },
        })}
        busy={false}
      />
    )
    expect(await screen.findByText("CLAUDE.md")).toBeTruthy()
    expect(screen.getByText("Instruction file")).toBeTruthy()
    expect(screen.getByText("loads #1")).toBeTruthy()
    expect(screen.getByText("Modified")).toBeTruthy()
    expect(screen.getByText("Not sent to a model")).toBeTruthy()
    expect(screen.getByText("1 finding(s)")).toBeTruthy()
    expect(screen.getByText("Could not read: skill")).toBeTruthy()
    // Agent files are not Prompt Center resources.
    expect(screen.getAllByText("Open in Prompt Center")).toHaveLength(2)
    fireEvent.click(screen.getAllByText("Audit")[0]!)
    expect(rt.audit).toHaveBeenCalledWith("w", ["instruction-file:/r/CLAUDE.md"])
    expect(screen.getByTestId("governance-facts").textContent).toContain(
      "— hooks · 2 permission rules · 1 MCP servers · 3 of 4 Skills enabled"
    )
    expect(screen.getByText(EN["inventory.hooksUnavailable"]!)).toBeTruthy()
  })

  it("shows a listing failure", async () => {
    render(
      <InventoryTab
        runtime={runtime({
          surfaces: jest.fn(async () => {
            throw new Error("denied")
          }),
        })}
        workspaceId={null}
        data={emptyData()}
        busy={false}
      />
    )
    await waitFor(() => expect(screen.getByText("denied")).toBeTruthy())
  })
})
