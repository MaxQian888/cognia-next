/** @jest-environment jsdom */

import "fake-indexeddb/auto"

const push = jest.fn()
jest.mock("next/navigation", () => ({ useRouter: () => ({ push }) }))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { enqueueHostDispatch, recordHostDispatchRemoteRun } from "@/lib/db/host-dispatch-queue"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { useRemoteHostStore, type RemoteHost } from "@/stores/remote-host/remote-host-store"
import { WorkflowHandoffPanel, findHostByIdentity } from "./handoff-panel"

const messages = {
  workflows: {
    runs: {
      handoff: {
        title: "Handoffs",
        description: "Runs dispatched to another host",
        openTarget: "Open on host",
        targetNotPaired: "host not paired here",
        cancel: "Cancel",
        cancelled: "Handoff cancelled",
        remoteRun: "run {runId}",
        reason: "{code}: {error}",
        status: {
          pending: "Queued",
          inflight: "Sending",
          "awaiting-result": "Awaiting result",
          succeeded: "Handed off",
          failed: "Failed",
          cancelled: "Cancelled",
          deadletter: "Gave up",
        },
      },
    },
  },
}

const NOW = 1_700_000_000_000

function host(overrides: Partial<RemoteHost> = {}): RemoteHost {
  return {
    id: "local-row-1",
    label: "Cloud box",
    config: { baseUrl: "https://cloud" } as RemoteHost["config"],
    credentialRef: "cred",
    addedAt: NOW,
    connectionState: "ready",
    featureManifest: {
      schemaVersion: 2,
      hostIdentity: { id: "identity-a" },
      features: {},
    } as RemoteHost["featureManifest"],
    ...overrides,
  }
}

function renderPanel(props: Partial<Parameters<typeof WorkflowHandoffPanel>[0]> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <WorkflowHandoffPanel workflowId="wf-1" {...props} />
    </NextIntlClientProvider>
  )
}

async function seed(overrides: Parameters<typeof enqueueHostDispatch>[0]) {
  return enqueueHostDispatch(overrides)
}

describe("WorkflowHandoffPanel", () => {
  beforeEach(async () => {
    push.mockClear()
    __resetDbForTesting()
    await getDb().hostDispatchQueue.clear()
    useRemoteHostStore.setState({ hosts: [], activeHostId: null })
  }, 15_000)

  it("renders nothing when the workflow has no handoffs", async () => {
    renderPanel()
    await waitFor(() =>
      expect(screen.queryByTestId("workflow-handoff-panel")).not.toBeInTheDocument()
    )
  })

  it("ignores handoffs belonging to another workflow", async () => {
    await seed({
      accountId: "acct",
      domain: "schedule-handoff",
      targetRef: "identity-a",
      kind: "workflow.trigger",
      payload: {},
      idempotencyKey: "other",
      label: "wf-2",
      now: NOW,
    })
    renderPanel()
    await waitFor(() =>
      expect(screen.queryByTestId("workflow-handoff-panel")).not.toBeInTheDocument()
    )
  })

  it("names the target host and offers to open it", async () => {
    const user = userEvent.setup()
    useRemoteHostStore.setState({ hosts: [host()], activeHostId: null })
    await seed({
      accountId: "acct",
      domain: "schedule-handoff",
      targetRef: "identity-a",
      kind: "workflow.trigger",
      payload: {},
      idempotencyKey: "h1",
      label: "wf-1",
      now: NOW,
    })
    const onOpenTarget = jest.fn()
    renderPanel({ onOpenTarget })

    expect(await screen.findByTestId("workflow-handoff-target")).toHaveTextContent("Cloud box")
    await user.click(screen.getByTestId("workflow-handoff-open"))
    expect(onOpenTarget).toHaveBeenCalledWith(expect.objectContaining({ id: "local-row-1" }))
  })

  it("falls back to the raw identity when the target is not paired here", async () => {
    await seed({
      accountId: "acct",
      domain: "schedule-handoff",
      targetRef: "identity-ghost",
      kind: "workflow.trigger",
      payload: {},
      idempotencyKey: "h-ghost",
      label: "wf-1",
      now: NOW,
    })
    renderPanel()

    expect(await screen.findByTestId("workflow-handoff-target")).toHaveTextContent("identity-ghost")
    expect(screen.getByTestId("workflow-handoff-unpaired")).toBeInTheDocument()
    expect(screen.queryByTestId("workflow-handoff-open")).not.toBeInTheDocument()
  })

  it("cancels a handoff the target has not admitted yet", async () => {
    const user = userEvent.setup()
    const row = await seed({
      accountId: "acct",
      domain: "schedule-handoff",
      targetRef: "identity-a",
      kind: "workflow.trigger",
      payload: {},
      idempotencyKey: "h-cancel",
      label: "wf-1",
      now: NOW,
    })
    renderPanel()

    await user.click(await screen.findByTestId("workflow-handoff-cancel"))
    await waitFor(async () =>
      expect(await getDb().hostDispatchQueue.get(row.id)).toMatchObject({
        status: "cancelled",
        terminalCode: "cancelled_by_source",
      })
    )
  })

  it("shows the remote run and refuses to cancel once the target admitted it", async () => {
    const row = await seed({
      accountId: "acct",
      domain: "schedule-handoff",
      targetRef: "identity-a",
      kind: "workflow.trigger",
      payload: {},
      idempotencyKey: "h-admitted",
      label: "wf-1",
      now: NOW,
    })
    await recordHostDispatchRemoteRun(row.id, "remote-run-9", NOW + 1)
    renderPanel()

    expect(await screen.findByTestId("workflow-handoff-run")).toHaveTextContent("run remote-run-9")
    expect(screen.queryByTestId("workflow-handoff-cancel")).not.toBeInTheDocument()
  })

  it("surfaces the terminal code and error of a failed handoff", async () => {
    const row = await seed({
      accountId: "acct",
      domain: "schedule-handoff",
      targetRef: "identity-a",
      kind: "workflow.trigger",
      payload: {},
      idempotencyKey: "h-failed",
      label: "wf-1",
      now: NOW,
    })
    await getDb().hostDispatchQueue.update(row.id, {
      status: "deadletter",
      terminalCode: "handoff_failed",
      lastError: "host offline",
    })
    renderPanel()

    const reason = await screen.findByTestId("workflow-handoff-reason")
    expect(reason).toHaveTextContent("handoff_failed: host offline")
    expect(screen.getByTestId("workflow-handoff-row")).toHaveAttribute("data-status", "deadletter")
    expect(screen.queryByTestId("workflow-handoff-cancel")).not.toBeInTheDocument()
  })

  it("matches a target by its stable host identity, never by the local row id", () => {
    const rows = [host({ id: "local-row-1" })]
    expect(findHostByIdentity(rows, "identity-a")?.id).toBe("local-row-1")
    // Re-pairing mints a new local row id; matching on it would break the link.
    expect(findHostByIdentity(rows, "local-row-1")).toBeUndefined()
  })
})
