/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"
import { render, screen, fireEvent } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { createEditorStore } from "@/lib/workflow/editor/store"
import type { VisualWorkflow } from "@/types/workflow/visual"

const publishWorkflow = jest.fn()
const unpublishWorkflow = jest.fn()
jest.mock("@/lib/workflow/publish/publish-workflow", () => ({
  publishWorkflow: (...args: unknown[]) => publishWorkflow(...args),
  unpublishWorkflow: (...args: unknown[]) => unpublishWorkflow(...args),
}))

const EMPTY_CATALOG: never[] = []
jest.mock("@/lib/workflow/nodes/catalog", () => ({
  subscribePluginCatalog: () => () => {},
  // Must return a STABLE reference — useSyncExternalStore loops otherwise.
  getPluginCatalogSnapshot: () => EMPTY_CATALOG,
}))

import { SettingsTab } from "./settings-tab"

const messages = {
  workflows: {
    forms: {
      wait: { durationMs: { units: { ms: "ms", sec: "seconds", min: "minutes", hour: "hours" } } },
    },
  },
  workflowEditor: {
    settings: {
      runPolicy: { title: "Run policy" },
      errorPolicy: {
        label: "On error",
        stop: "Stop the run",
        continue: "Continue",
        branch: "Route to error branch",
      },
      timeoutMs: { label: "Run timeout", hint: "ceiling" },
      concurrency: { label: "Concurrent runs", hint: "h" },
      maxConcurrency: { label: "Max in-run nodes", hint: "h" },
      retry: {
        title: "Retry defaults",
        attempts: "Attempts",
        backoff: "Backoff",
        exponential: "Exponential",
        fixed: "Fixed",
        baseMs: "Base (ms)",
        maxMs: "Max (ms)",
      },
      timezone: { label: "Timezone", hint: "h" },
      onFailure: {
        title: "Failure handling",
        hint: "h",
        runCatchNodes: { label: "Run catch nodes", hint: "h" },
        notify: { label: "Notify on failure", hint: "h" },
      },
      variables: {
        title: "Variables",
        hint: "h",
        addButton: "Add variable",
        keyPlaceholder: "KEY",
        valuePlaceholder: "value",
        removeAria: "Remove variable",
        invalidKey: "Invalid",
        duplicateKey: "Dup",
        empty: "No variables yet.",
      },
      credentials: {
        title: "Credentials",
        hint: "h",
        addButton: "Add credential ref",
        idPlaceholder: "id",
        namePlaceholder: "name",
        kindPlaceholder: "kind",
        removeAria: "Remove",
        refOnlyNote: "Refs only.",
        empty: "No credential references yet.",
      },
      plugins: {
        title: "Plugins & capabilities",
        hint: "h",
        empty: "No plugin-contributed workflow capabilities installed.",
        sections: { nodes: "Nodes", triggers: "Triggers", templates: "Templates" },
        contributedBy: "Provided by {plugin}",
      },
      publish: {
        title: "Publish",
        hint: "Publish hint",
        publish: "Publish",
        publishedAs: "Published as tool",
        republish: "Re-publish",
        unpublish: "Unpublish",
      },
    },
  },
}

function makeWorkflow(): VisualWorkflow {
  return {
    id: "wf",
    schemaVersion: 1,
    name: "WF",
    createdAt: 1,
    updatedAt: 1,
    nodes: [],
    edges: [],
    settings: {
      errorPolicy: "stop",
      timeoutMs: 60_000,
      concurrency: 1,
      retryDefaults: { attempts: 3, backoff: "exponential", baseMs: 1000 },
    },
  }
}

function mount() {
  const store = createEditorStore(makeWorkflow())
  render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <SettingsTab useStore={store} />
    </NextIntlClientProvider>
  )
  return store
}

describe("SettingsTab", () => {
  beforeEach(() => {
    publishWorkflow.mockReset()
    unpublishWorkflow.mockReset()
  })

  it("renders all sections", () => {
    mount()
    expect(screen.getByTestId("workflow-settings-tab")).toBeInTheDocument()
    expect(screen.getByText("Run policy")).toBeInTheDocument()
    expect(screen.getByText("Retry defaults")).toBeInTheDocument()
    expect(screen.getByTestId("workflow-variables-editor")).toBeInTheDocument()
    expect(screen.getByTestId("workflow-credentials-list")).toBeInTheDocument()
  })

  it("editing concurrency writes through setSettings and marks dirty", () => {
    const store = mount()
    const input = screen.getByLabelText("Concurrent runs")
    fireEvent.change(input, { target: { value: "4" } })
    expect(store.getState().baseWorkflow.settings.concurrency).toBe(4)
    expect(store.getState().dirty).toBe(true)
  })

  it("displays the shared max-concurrency default (4) when the field is absent", () => {
    // makeWorkflow's settings carry no maxConcurrency — the input must show
    // DEFAULT_MAX_CONCURRENCY, matching what the zod backfill actually runs,
    // never the old sequential `1`.
    mount()
    expect(screen.getByLabelText("Max in-run nodes")).toHaveValue(4)
  })

  it("editing a retry attempt count writes through setSettings", () => {
    const store = mount()
    fireEvent.change(screen.getByLabelText("Attempts"), { target: { value: "5" } })
    expect(store.getState().baseWorkflow.settings.retryDefaults.attempts).toBe(5)
  })

  it("toggling onFailure switches writes through setSettings", () => {
    const store = mount()
    // Default: runCatchNodes on (checked), notify off.
    fireEvent.click(screen.getByTestId("wf-onfailure-runcatch"))
    expect(store.getState().baseWorkflow.settings.onFailure?.runCatchNodes).toBe(false)
    fireEvent.click(screen.getByTestId("wf-onfailure-notify"))
    expect(store.getState().baseWorkflow.settings.onFailure?.notify).toBe(true)
  })

  // ── ADR-0070 Phase 3 — the risk-gating opt-out ──────────────────────────
  it("toggling risk gating writes through setSettings", () => {
    // Reachability is the point: the changeset documents `riskGating: false`
    // as the escape hatch for a gated workflow, so it must be settable here.
    const store = mount()
    fireEvent.click(screen.getByTestId("wf-risk-gating"))
    expect(store.getState().baseWorkflow.settings.riskGating).toBe(true)
    fireEvent.click(screen.getByTestId("wf-risk-gating"))
    expect(store.getState().baseWorkflow.settings.riskGating).toBe(false)
  })

  it("syncs publish and unpublish results into the editor store without marking it dirty", async () => {
    const workflowInterface = {
      inputSchema: { type: "object" },
      outputSchema: { type: "string" },
    }
    publishWorkflow.mockResolvedValue({
      toolName: "wf_wf",
      workflowInterface,
      created: true,
      skillId: "skill_wf",
    })
    unpublishWorkflow.mockResolvedValue(undefined)
    const store = mount()

    fireEvent.click(screen.getByTestId("workflow-publish-button"))

    await screen.findByText("wf_wf")
    expect(store.getState().baseWorkflow.published).toEqual({
      at: expect.any(Number),
      toolName: "wf_wf",
    })
    expect(store.getState().baseWorkflow.interface).toEqual(workflowInterface)
    expect(store.getState().dirty).toBe(false)

    fireEvent.click(screen.getByText("Unpublish"))

    await screen.findByTestId("workflow-publish-button")
    expect(store.getState().baseWorkflow.published).toBeUndefined()
    expect(store.getState().baseWorkflow.interface).toBeUndefined()
    expect(store.getState().dirty).toBe(false)
  })
})
