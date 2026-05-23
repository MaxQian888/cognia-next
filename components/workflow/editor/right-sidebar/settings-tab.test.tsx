/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"
import { render, screen, fireEvent } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { createEditorStore } from "@/lib/workflow/editor/store"
import type { VisualWorkflow } from "@/types/workflow/visual"

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

  it("editing a retry attempt count writes through setSettings", () => {
    const store = mount()
    fireEvent.change(screen.getByLabelText("Attempts"), { target: { value: "5" } })
    expect(store.getState().baseWorkflow.settings.retryDefaults.attempts).toBe(5)
  })
})
