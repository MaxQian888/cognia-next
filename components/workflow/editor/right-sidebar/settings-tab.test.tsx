/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"
import { render, screen, fireEvent } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { createEditorStore } from "@/lib/workflow/editor/store"
import { enqueueHostDispatch } from "@/lib/db/host-dispatch-queue"
import { getDb } from "@/lib/db/schema"
import { useRemoteHostStore } from "@/stores/remote-host/remote-host-store"
import { TIMEZONE_OPTIONS } from "@/types/scheduler"
import type { VisualWorkflow } from "@/types/workflow/visual"

jest.setTimeout(15_000)

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
      runOn: {
        label: "Run on",
        hint: "Choose a Host for top-level asynchronous runs.",
        colocate: "This Host",
        auto: "Auto (least loaded)",
        pinnedGroup: "Pinned Host",
        publishRequired: "Publish before selecting remote placement.",
        noCompatibleHosts: "No compatible Remote Hosts.",
        handoffActive: "{count} handoff waiting or retrying.",
        handoffFailed: "{count} handoff failed.",
      },
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

function mount(workflow = makeWorkflow()) {
  const store = createEditorStore(workflow)
  render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <SettingsTab useStore={store} />
    </NextIntlClientProvider>
  )
  return store
}

describe("SettingsTab", () => {
  beforeEach(async () => {
    publishWorkflow.mockReset()
    unpublishWorkflow.mockReset()
    useRemoteHostStore.setState({ activeHostId: null, hosts: [] })
    await getDb().hostDispatchQueue.clear()
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

  it("stores workflow-level auto placement for a published workflow", () => {
    const workflow = makeWorkflow()
    workflow.published = {
      at: 1,
      toolName: "wf_wf",
      versionId: "wfv_wf_1",
      deploymentId: "wfd_wf",
      deploymentRevision: 1,
    }
    const store = mount(workflow)

    fireEvent.click(screen.getByLabelText("Run on"))
    fireEvent.click(screen.getByText("Auto (least loaded)"))

    expect(store.getState().baseWorkflow.settings.runOn).toEqual({ mode: "auto" })
    expect(store.getState().dirty).toBe(true)
  })

  it("pins a published workflow to the compatible Host's stable identity", () => {
    const workflow = makeWorkflow()
    workflow.published = {
      at: 1,
      toolName: "wf_wf",
      versionId: "wfv_wf_1",
      deploymentId: "wfd_wf",
      deploymentRevision: 1,
    }
    useRemoteHostStore.setState({
      hosts: [
        {
          id: "cloud-row",
          label: "Cloud Host",
          credentialRef: "remote-host:cloud-row",
          addedAt: 1,
          connectionState: "ready",
          config: { baseUrl: "https://cloud.example", deviceId: "device-1" },
          featureManifest: {
            schemaVersion: 2,
            hostBuildId: "build-1",
            platform: "headless",
            generatedAt: 1,
            hostIdentity: { id: "cloud-stable", kind: "cloud" },
            protocol: { min: 1, max: 2 },
            operations: [],
            features: { "workflow.execution": { version: 1 } },
          },
        } as never,
      ],
    })
    const store = mount(workflow)

    fireEvent.click(screen.getByLabelText("Run on"))
    fireEvent.click(screen.getByText("Cloud Host"))

    expect(store.getState().baseWorkflow.settings.runOn).toEqual({
      mode: "pinned",
      ref: "cloud-stable",
    })
  })

  it("surfaces durable waiting and failed handoff records", async () => {
    const workflow = makeWorkflow()
    workflow.published = { at: 1, toolName: "wf_wf" }
    await enqueueHostDispatch({
      id: "handoff-active",
      accountId: "account-1",
      domain: "schedule-handoff",
      targetRef: "cloud-a",
      kind: "workflow.trigger",
      payload: {},
      idempotencyKey: "handoff-active",
      label: workflow.id,
    })
    await enqueueHostDispatch({
      id: "handoff-failed",
      accountId: "account-1",
      domain: "schedule-handoff",
      targetRef: "cloud-b",
      kind: "workflow.trigger",
      payload: {},
      idempotencyKey: "handoff-failed",
      label: workflow.id,
    })
    await getDb().hostDispatchQueue.update("handoff-failed", { status: "deadletter" })

    mount(workflow)

    expect(await screen.findByTestId("wf-handoff-active")).toHaveTextContent("1 handoff")
    expect(await screen.findByTestId("wf-handoff-failed")).toHaveTextContent("1 handoff")
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

  it("writes every numeric and select run-policy control through setSettings", () => {
    const store = mount()

    fireEvent.change(screen.getByLabelText("Concurrent runs"), { target: { value: "invalid" } })
    fireEvent.change(screen.getByLabelText("Max in-run nodes"), { target: { value: "8" } })
    fireEvent.change(screen.getByLabelText("Base (ms)"), { target: { value: "250" } })
    fireEvent.change(screen.getByLabelText("Max (ms)"), { target: { value: "2000" } })
    fireEvent.change(screen.getByLabelText("Run timeout"), { target: { value: "2" } })
    fireEvent.pointerDown(screen.getByLabelText("On error"), { button: 0, ctrlKey: false })
    fireEvent.click(screen.getByRole("option", { name: /^Continue/ }))
    fireEvent.pointerDown(screen.getByLabelText("Backoff"), { button: 0, ctrlKey: false })
    fireEvent.click(screen.getByRole("option", { name: /^Fixed/ }))
    const otherTimezone = TIMEZONE_OPTIONS.find((timezone) => timezone.value !== "UTC")!
    fireEvent.pointerDown(screen.getByTestId("wf-timezone"), { button: 0, ctrlKey: false })
    fireEvent.click(screen.getByRole("option", { name: otherTimezone.label }))

    expect(store.getState().baseWorkflow.settings).toMatchObject({
      concurrency: 1,
      maxConcurrency: 8,
      timeoutMs: 120_000,
      timezone: otherTimezone.value,
      errorPolicy: "continue",
      retryDefaults: {
        attempts: 3,
        backoff: "fixed",
        baseMs: 250,
        maxMs: 2000,
      },
    })
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
