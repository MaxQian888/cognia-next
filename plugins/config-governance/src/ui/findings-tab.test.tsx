/**
 * @jest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { registerPluginI18n, unregisterPluginI18n } from "@cognia/plugin-sdk/api/i18n"

import manifestJson from "../../plugin.json"
import type { RuleCheck } from "../adherence/checks"
import type { AuditRun, Finding, Hunk } from "../model"
import { PLUGIN_ID } from "../model"
import type { GovernanceRuntime } from "../runtime/runtime"
import { FindingsTab, selectableByDefault } from "./findings-tab"
import type { GovernanceData } from "./use-governance"

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

const KEY = "instruction-file:/r/CLAUDE.md"

function finding(id: string, partial: Partial<Finding> = {}): Finding {
  return {
    id,
    group: "dated-text",
    pattern: "fossil",
    location: { surfaceKey: KEY, startLine: 2, endLine: 2 },
    evidence: `evidence ${id}`,
    reason: "",
    confidence: "high",
    action: "remove",
    sources: ["judge"],
    ...partial,
  }
}

const hunk = (findingId: string, proposedOnly = false): Hunk => ({
  findingId,
  surfaceKey: KEY,
  startLine: 2,
  endLine: 2,
  before: ["old line"],
  after: [],
  proposedOnly,
})

const check: RuleCheck = {
  id: "C",
  kind: "forbid",
  trigger: { family: "shell", command: "^rm" },
  scope: "turn",
  summary: "No rm",
  rule: { surfaceKey: KEY, surfaceName: "CLAUDE.md", startLine: 4, endLine: 4, text: "Never rm." },
}

function data(findings: Finding[], hunks: Hunk[], kept: string[] = []): GovernanceData {
  const run: AuditRun = {
    id: "r",
    workspaceId: "w",
    startedAt: 0,
    finishedAt: 0,
    targetModel: "m",
    surfaces: [
      {
        surface: { key: KEY, name: "CLAUDE.md" } as AuditRun["surfaces"][number]["surface"],
        textHash: "",
        lineCount: 4,
      },
    ],
    findings,
    hunks,
    failedSources: [],
    notes: [],
  }
  return {
    run,
    findings,
    kept: new Set(kept),
    results: new Map([
      [
        "C",
        {
          checkId: "C",
          sessionsScanned: 1,
          sessionsTriggered: 1,
          opportunities: 4,
          followed: 1,
          violated: 3,
          excluded: 0,
          samples: [],
        },
      ],
    ]),
    checksById: new Map([["C", check]]),
    rules: [],
    applied: [],
    evals: [],
    history: [],
    falseMatches: new Set(),
  }
}

function runtime() {
  return {
    apply: jest.fn(async () => [{ surfaceKey: KEY, status: "applied", hunks: 1, resultKey: KEY }]),
    setKept: jest.fn(async () => {}),
    adopt: jest.fn(async () => ({})),
    openInPromptCenter: jest.fn(() => true),
  } as unknown as GovernanceRuntime & Record<string, jest.Mock>
}

describe("selectableByDefault", () => {
  it("takes findings with ordinary hunks that are not kept", () => {
    const findings = [finding("a"), finding("b"), finding("c"), finding("d")]
    expect(
      selectableByDefault(findings, [hunk("a"), hunk("b", true), hunk("c")], new Set(["c"]))
    ).toEqual(["a"])
  })
})

describe("FindingsTab", () => {
  it("says when there is nothing yet", () => {
    render(
      <FindingsTab
        runtime={runtime()}
        workspaceId="w"
        data={{ ...data([], []), run: undefined }}
        busy={false}
      />
    )
    expect(screen.getByText(manifestJson.i18n.locales.en["findings.none"])).toBeTruthy()
  })

  it("lists findings with their pattern, location, evidence and explanation", () => {
    render(
      <FindingsTab
        runtime={runtime()}
        workspaceId="w"
        data={data(
          [finding("a", { reason: "Model reason." }), finding("b", { pattern: "stale-fact" })],
          [hunk("a")]
        )}
        busy={false}
      />
    )
    expect(screen.getAllByText("Fossil").length).toBeGreaterThan(0)
    expect(screen.getAllByText(/CLAUDE\.md · lines 2/).length).toBe(2)
    expect(screen.getByText("evidence a")).toBeTruthy()
    expect(screen.getByText("Model reason.")).toBeTruthy()
    expect(screen.getByText(manifestJson.i18n.locales.en["explain.stale-fact"])).toBeTruthy()
  })

  it("selects suggested edits, shows the diff and applies", async () => {
    const rt = runtime()
    render(
      <FindingsTab
        runtime={rt}
        workspaceId="w"
        data={data(
          [finding("a"), finding("p")],
          [hunk("a"), { ...hunk("p", true), startLine: 3, endLine: 3 }]
        )}
        busy={false}
      />
    )
    fireEvent.click(screen.getByText("Select suggested edits"))
    fireEvent.click(screen.getByText("Apply selected (1)"))
    await waitFor(() => expect(rt.apply).toHaveBeenCalledWith("w", new Set(["a"])))
    expect(await screen.findByText("CLAUDE.md: 1 change(s) applied")).toBeTruthy()
    fireEvent.click(screen.getAllByText("Show change")[0]!)
    expect(screen.getByTestId("governance-diff").textContent).toContain("old line")
    expect(screen.getByText("Pick yourself")).toBeTruthy()
  })

  it("keeps a rule, hides kept findings and opens the Prompt Center", () => {
    const rt = runtime()
    render(
      <FindingsTab
        runtime={rt}
        workspaceId="w"
        data={data([finding("a"), finding("k")], [], ["k"])}
        busy={false}
      />
    )
    expect(screen.queryByText("evidence k")).toBeNull()
    fireEvent.click(screen.getByText("Keep this rule"))
    expect(rt.setKept).toHaveBeenCalledWith("w", "a", true)
    fireEvent.click(screen.getByText("Open in Prompt Center"))
    expect(rt.openInPromptCenter).toHaveBeenCalledWith(KEY, "w")
  })

  it("adopts an enforcement rule from a rule that is not followed", () => {
    const rt = runtime()
    const unfollowed = finding("u", {
      group: "adherence",
      pattern: "unfollowed-rule",
      action: "enforce",
      checkId: "C",
    })
    render(<FindingsTab runtime={rt} workspaceId="w" data={data([unfollowed], [])} busy={false} />)
    expect(screen.getByText("Followed 1 of 4 times in replayed sessions.")).toBeTruthy()
    fireEvent.click(screen.getByText("Enforce…"))
    fireEvent.click(screen.getByText("Block"))
    expect(rt.adopt).toHaveBeenCalledWith(check, "block", "w", "u")
  })
})
