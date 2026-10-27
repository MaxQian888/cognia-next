import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { LumeSettings } from "./lume-settings"
import {
  createLumeClient,
  LumeClientError,
  type LumeClient,
  type LumeResource,
} from "@/lib/automation/lume-client"
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, string>) =>
    values ? `${key} ${Object.values(values).join(" ")}` : key,
}))
jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  isTauri: () => true,
}))
jest.mock("@/lib/tauri/transport-instance", () => ({ localTransport: { call: jest.fn() } }))
jest.mock("@/lib/db/sandbox-connections", () => ({
  getSandboxConnection: jest.fn(),
  putSandboxConnection: jest.fn(),
}))
jest.mock("./sandbox-desktop-viewer", () => ({ SandboxDesktopViewer: () => null }))
const resource: LumeResource = {
  resourceId: "r",
  generation: 1,
  bootEpoch: "b",
  connectionId: "c",
  vmName: "owned",
  state: "running",
  readiness: { vm: true, ssh: false, helper: false, gui: false },
  quarantine: false,
  memoryMb: 8192,
  lastErrorCode: null,
  groupId: null,
}

test("native preparation is explicit and stop remains available during a pending operation", async () => {
  const run = jest
    .fn()
    .mockImplementationOnce(() => new Promise(() => undefined))
    .mockResolvedValue({ state: "succeeded" })
  const client = {
    diagnose: jest.fn().mockResolvedValue({
      contractVersion: 1,
      platformSupported: true,
      enabled: true,
      resources: [resource],
    }),
    run,
  } as unknown as LumeClient
  const view = render(<LumeSettings client={client} />)
  await screen.findByRole("button", { name: "stop" })
  expect(run).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: "start" }))
  expect(screen.getByRole("button", { name: "start" })).toBeDisabled()
  expect(screen.getByRole("button", { name: "stop" })).toBeEnabled()
  fireEvent.click(screen.getByRole("button", { name: "stop" }))
  await waitFor(() =>
    expect(run).toHaveBeenCalledWith({
      kind: "stop",
      reference: { resourceId: "r", generation: 1, bootEpoch: "b" },
    })
  )
  view.unmount()
})

test("unknown Host contract is refused before publishing VM projections", async () => {
  const client = {
    diagnose: jest.fn().mockResolvedValue({ contractVersion: 99, resources: [resource] }),
  } as unknown as LumeClient
  render(<LumeSettings client={client} />)
  expect(await screen.findByRole("alert")).toHaveTextContent("errors.version")
  expect(screen.queryByRole("button", { name: "stop" })).not.toBeInTheDocument()
})

test("cancel stays pending until the recorded native transport confirms completion", async () => {
  let releasePoll!: () => void
  const call = jest.fn(async (request) => {
    if (request.kind === "diagnose")
      return { contractVersion: 1, enabled: true, platformSupported: true, resources: [resource] }
    if (request.kind === "begin")
      return { id: "pending", state: "running", stage: "awaitingConsent", resource: null }
    if (request.kind === "poll")
      return {
        id: "pending",
        state: "failed",
        stage: "finished",
        errorCode: "lume_operation_cancelled",
        resource: null,
      }
    return null
  })
  const client = createLumeClient(
    call as never,
    () =>
      new Promise<void>((resolve) => {
        releasePoll = resolve
      })
  )
  render(<LumeSettings client={client} />)
  fireEvent.click(await screen.findByRole("button", { name: "prepareSsh" }))
  expect(await screen.findByRole("status")).toHaveTextContent("stages.awaitingConsent")
  fireEvent.click(screen.getByRole("button", { name: "cancelOperation" }))
  expect(screen.getByRole("button", { name: "prepareSsh" })).toBeDisabled()
  expect(screen.getByRole("button", { name: "stop" })).toBeEnabled()
  expect(screen.getByRole("status")).toHaveTextContent("cancellationPending")
  expect(call).toHaveBeenCalledWith({ kind: "cancel", operation_id: "pending" })
  await act(async () => releasePoll())
  await waitFor(() => expect(screen.getByRole("button", { name: "prepareSsh" })).toBeEnabled())
  expect(screen.getByRole("status")).toHaveTextContent("errors.cancelled")
})

test("unmount requests cancellation and does not refresh or publish a late preparation result", async () => {
  let deliver!: (status: unknown) => void
  const call = jest.fn(async (request) => {
    if (request.kind === "diagnose")
      return { contractVersion: 1, enabled: true, platformSupported: true, resources: [resource] }
    if (request.kind === "begin")
      return new Promise((resolve) => {
        deliver = resolve
      })
    if (request.kind === "poll")
      return {
        id: "late",
        state: "failed",
        stage: "finished",
        errorCode: "lume_operation_cancelled",
      }
    return null
  })
  const client = createLumeClient(call as never, async () => undefined)
  const view = render(<LumeSettings client={client} />)
  fireEvent.click(await screen.findByRole("button", { name: "prepareSsh" }))
  const reads = call.mock.calls.filter(([request]) => request.kind === "diagnose").length
  view.unmount()
  await act(async () => deliver({ id: "late", state: "running", stage: "awaitingConsent" }))
  await waitFor(() => expect(call).toHaveBeenCalledWith({ kind: "cancel", operation_id: "late" }))
  expect(call.mock.calls.filter(([request]) => request.kind === "diagnose")).toHaveLength(reads)
})

test("capacity failures show a localized recovery action without rendering native text", async () => {
  const client = {
    diagnose: jest
      .fn()
      .mockResolvedValue({ contractVersion: 1, enabled: true, resources: [resource] }),
    run: jest.fn().mockRejectedValue(new LumeClientError("lume_capacity_disk")),
  } as unknown as LumeClient
  render(<LumeSettings client={client} />)
  fireEvent.click(await screen.findByRole("button", { name: "start" }))
  expect(await screen.findByRole("alert")).toHaveTextContent("errors.capacity")
})

test.each([
  ["lume_gui_unqualified", "guest"],
  ["lume_deleted_journal_recovery_required", "recovery"],
  ["lume_workspace_writers_active", "writers"],
])("native resource warning %s reaches localized recovery feedback", async (code, category) => {
  const call = jest.fn(async (request) =>
    request.kind === "diagnose"
      ? { contractVersion: 1, enabled: true, resources: [resource] }
      : {
          id: "health",
          state: "succeeded",
          stage: "finished",
          resource: { ...resource, lastErrorCode: code },
          errorCode: null,
          output: null,
        }
  )
  render(<LumeSettings client={createLumeClient(call as never)} />)
  fireEvent.click(await screen.findByRole("button", { name: "health" }))
  expect(await screen.findByRole("alert")).toHaveTextContent(`errors.${category}`)
})

test("an older diagnostic response cannot replace a newer refreshed resource", async () => {
  let deliver!: (value: unknown) => void
  const current = {
    contractVersion: 1,
    enabled: true,
    resources: [{ ...resource, state: "stopped" }],
  }
  const diagnose = jest
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          deliver = resolve
        })
    )
    .mockResolvedValue(current)
  render(<LumeSettings client={{ diagnose } as unknown as LumeClient} />)
  fireEvent.click(screen.getByRole("button", { name: "refresh" }))
  await screen.findByText("state states.stopped")
  await act(async () => deliver({ ...current, resources: [resource] }))
  expect(screen.queryByText("state states.running")).not.toBeInTheDocument()
  expect(screen.getByText("state states.stopped")).toBeInTheDocument()
})

test("an older diagnostic failure cannot replace a newer successful refresh", async () => {
  let reject!: (cause: Error) => void
  const diagnose = jest
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          reject = fail
        })
    )
    .mockResolvedValue({ contractVersion: 1, enabled: true, resources: [resource] })
  render(<LumeSettings client={{ diagnose } as unknown as LumeClient} />)
  fireEvent.click(screen.getByRole("button", { name: "refresh" }))
  await screen.findByText("state states.running")
  await act(async () => reject(new Error("lume_host_restarted")))
  expect(screen.queryByRole("alert")).not.toBeInTheDocument()
})

test.each([false, true])(
  "a committed adoption preserves cancellation and recovery feedback (recovery=%s)",
  async (recovery) => {
    let releasePoll!: () => void
    const ready = {
      ...resource,
      readiness: { vm: true, ssh: true, helper: true, gui: true },
      workspaceRevision: "wsrev1:source",
    }
    const call = jest.fn(async (request) => {
      if (request.kind === "diagnose")
        return { contractVersion: 1, enabled: true, resources: [ready] }
      if (
        request.kind === "begin" &&
        (request.operation as { kind: string }).kind === "reviewWorkspace"
      )
        return {
          id: "review",
          state: "succeeded",
          stage: "finished",
          output: {
            reviewId: "review",
            sha256: "digest",
            hostRoot: "/source",
            patch: {
              base_revision: "wsrev1:source",
              files: [{ path: "a", action: "write", content: "reviewed" }],
            },
          },
        }
      if (request.kind === "begin")
        return { id: "adoption", state: "running", stage: "awaitingConsent" }
      if (request.kind === "poll")
        return {
          id: "adoption",
          state: "succeeded",
          stage: "finished",
          output: { status: "applied", effectCommitted: true, journalRecoveryRequired: recovery },
        }
      return null
    })
    const client = createLumeClient(
      call as never,
      () =>
        new Promise<void>((resolve) => {
          releasePoll = resolve
        })
    )
    render(<LumeSettings client={client} />)
    fireEvent.click(await screen.findByRole("button", { name: "reviewWorkspace" }))
    await screen.findByRole("textbox", { name: "workspaceDiff" })
    fireEvent.click(screen.getByRole("button", { name: "adoptWorkspace" }))
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("stages.awaitingConsent")
    )
    fireEvent.click(screen.getByRole("button", { name: "cancelOperation" }))
    await act(async () => releasePoll())
    if (recovery) {
      await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("errors.recovery"))
      expect(screen.queryByText("completedAfterCancel")).not.toBeInTheDocument()
    } else {
      await waitFor(() =>
        expect(screen.getByRole("status")).toHaveTextContent("completedAfterCancel")
      )
    }
    expect(screen.queryByRole("textbox", { name: "workspaceDiff" })).not.toBeInTheDocument()
    expect(screen.queryByText("errors.cancelled")).not.toBeInTheDocument()
  }
)

test.each(["conflict", "refused"] as const)(
  "workspace adoption reports %s and never publishes before approval",
  async (adoption) => {
    let imported = false
    const run = jest.fn().mockImplementation(async (operation) => {
      if (operation.kind === "importWorkspace") imported = true
      return {
        state: "succeeded",
        output:
          operation.kind === "reviewWorkspace"
            ? {
                reviewId: "review-1",
                sha256: "digest",
                patch: {
                  base_revision: "wsrev1:source",
                  files: [{ path: "a", action: "write", content: "reviewed text" }],
                },
              }
            : operation.kind === "adoptWorkspace"
              ? { status: adoption }
              : {},
      }
    })
    const client = {
      diagnose: jest.fn().mockImplementation(async () => ({
        contractVersion: 1,
        platformSupported: true,
        enabled: true,
        resources: [
          {
            ...resource,
            readiness: { vm: true, ssh: true, helper: true, gui: true },
            workspaceRevision: imported ? "wsrev1:source" : null,
          },
        ],
      })),
      run,
    } as unknown as LumeClient
    render(<LumeSettings client={client} />)
    await screen.findByRole("button", { name: "reviewWorkspace" })
    expect(screen.getByRole("button", { name: "adoptWorkspace" })).toBeDisabled()
    fireEvent.change(screen.getByRole("textbox", { name: "workspaceRoot" }), {
      target: { value: "/selected/source" },
    })
    fireEvent.click(screen.getByRole("button", { name: "importWorkspace" }))
    await waitFor(() =>
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "importWorkspace", host_root: "/selected/source" }),
        expect.any(AbortSignal),
        expect.any(Function)
      )
    )
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "reviewWorkspace" })).toBeEnabled()
    )
    fireEvent.click(screen.getByRole("button", { name: "reviewWorkspace" }))
    expect(
      ((await screen.findByRole("textbox", { name: "workspaceDiff" })) as HTMLTextAreaElement).value
    ).toContain("reviewed text")
    expect(run).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: "adoptWorkspace" }),
      expect.any(AbortSignal),
      expect.any(Function)
    )
    fireEvent.click(screen.getByRole("button", { name: "adoptWorkspace" }))
    await waitFor(() =>
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "adoptWorkspace", review_id: "review-1" }),
        expect.any(AbortSignal),
        expect.any(Function)
      )
    )
    expect(await screen.findByRole("alert")).toHaveTextContent(
      adoption === "conflict" ? "workspaceConflict" : "operationFailed"
    )
  }
)
