/**
 * @jest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
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

import { setActiveRuntime } from "../runtime/active"
import type { GovernanceRuntime, RuntimeStatus } from "../runtime/runtime"
import { GovernanceView } from "./governance-view"

function runtime(status: Partial<RuntimeStatus> = {}) {
  const listeners = new Set<() => void>()
  let current: RuntimeStatus = { revision: 0, ...status }
  const rt = {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getStatus: () => current,
    setStatus: (next: Partial<RuntimeStatus>) => {
      current = { ...current, ...next }
      for (const listener of listeners) listener()
    },
    cancel: jest.fn(),
    workspaces: jest.fn(async () => [{ id: "w", name: "Repo", roots: ["/r"] }]),
    defaultWorkspace: jest.fn(async () => "w"),
    findings: jest.fn(async () => []),
    modelChangedSince: jest.fn(async () => undefined),
    targetModel: () => "m",
    enforcementEnabled: () => true,
    evalDatasets: jest.fn(async () => []),
    surfaces: jest.fn(async () => ({ workspaceId: "w", surfaces: [], failed: [] })),
    facts: jest.fn(async () => ({
      hooksAvailable: true,
      hooks: [],
      permissionRules: [],
      mcpServers: [],
      skills: { total: 0, enabled: 0, builtIn: 0 },
    })),
    store: {
      latestRun: jest.fn(async () => undefined),
      keptFindings: jest.fn(async () => new Set()),
      checks: jest.fn(async () => undefined),
      adherence: jest.fn(async () => undefined),
      rules: jest.fn(async () => []),
      appliedChanges: jest.fn(async () => []),
      evalRecords: jest.fn(async () => []),
      history: jest.fn(async () => []),
      falseMatches: jest.fn(async () => new Set()),
    },
  }
  return rt
}

afterEach(() => act(() => setActiveRuntime(null)))

describe("GovernanceView", () => {
  it("says when the plugin is not running", () => {
    render(<GovernanceView pluginId={PLUGIN_ID} viewId="governance" />)
    expect(screen.getByText(EN["view.inactive"]!)).toBeTruthy()
  })

  it("loads the default workspace and shows the tabs", async () => {
    const rt = runtime()
    setActiveRuntime(rt as unknown as GovernanceRuntime)
    render(<GovernanceView pluginId={PLUGIN_ID} viewId="governance" />)
    expect(await screen.findByText("Overview")).toBeTruthy()
    for (const tab of ["Findings", "Adherence", "Enforcement", "Verify", "Inventory"])
      expect(screen.getByText(tab)).toBeTruthy()
    expect(rt.store.latestRun).toHaveBeenCalledWith("w")
    expect(screen.getByText(EN["overview.never"]!)).toBeTruthy()
  })

  it("shows progress with a cancel button, then the failure", async () => {
    const rt = runtime({
      busy: { kind: "audit", workspaceId: "w", done: 1, total: 4, label: "CLAUDE.md" },
    })
    setActiveRuntime(rt as unknown as GovernanceRuntime)
    render(<GovernanceView pluginId={PLUGIN_ID} viewId="governance" />)
    expect(await screen.findByText("Auditing CLAUDE.md")).toBeTruthy()
    fireEvent.click(screen.getByText("Cancel"))
    expect(rt.cancel).toHaveBeenCalled()
    act(() => rt.setStatus({ busy: undefined, error: { kind: "audit", message: "boom" } }))
    await waitFor(() =>
      expect(screen.getByTestId("governance-error").textContent).toBe("Audit failed: boom")
    )
    // A coded failure is said in the user's language, not the raw message.
    act(() =>
      rt.setStatus({
        busy: undefined,
        error: { kind: "derive", message: "raw", code: "governance_unparseable" },
      })
    )
    await waitFor(() =>
      expect(screen.getByTestId("governance-error").textContent).toBe(
        `Deriving checks failed: ${EN["errors.unparseable"]}`
      )
    )
  })

  it("re-renders once activation sets the runtime", async () => {
    render(<GovernanceView pluginId={PLUGIN_ID} viewId="governance" />)
    expect(screen.getByText(EN["view.inactive"]!)).toBeTruthy()
    act(() => setActiveRuntime(runtime() as unknown as GovernanceRuntime))
    expect(await screen.findByText("Overview")).toBeTruthy()
  })
})
