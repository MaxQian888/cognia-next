import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { GitHubRunnerPanel } from "./github-runner-panel"
import {
  githubRunnerClient,
  loadRunnerCreateConfig,
  saveRunnerCreateConfig,
} from "@/lib/remote-host/github-runner/client"
import { openExternal } from "@/lib/tauri/opener"

let desktop = true
let locale = "en"
const translate = (key: string, values?: { minutes?: number }) =>
  values?.minutes ? `${key} ${values.minutes}` : key
const alternateTranslate = (key: string) => key
const activateHost = jest.fn()
const deactivate = jest.fn()
const addHost = jest.fn(() => ({ id: "paired-host" }))
const store = {
  hosts: [] as Array<{ id: string }>,
  activeHostId: undefined as string | undefined,
  activateHost,
  deactivate,
  addHost,
}
jest.mock("next-intl", () => ({
  useTranslations: () => (locale === "en" ? translate : alternateTranslate),
  useLocale: () => locale,
}))
jest.mock("@/lib/tauri/opener", () => ({ openExternal: jest.fn().mockResolvedValue(undefined) }))
jest.mock("@/lib/platform/detect", () => ({ isTauri: () => desktop }))
jest.mock("@/lib/tauri/transport-instance", () => ({ localTransport: { call: jest.fn() } }))
jest.mock("@/stores/remote-host/remote-host-store", () => ({
  useRemoteHostStore: Object.assign(
    (selector: (value: typeof store) => unknown) => selector(store),
    { getState: () => store }
  ),
}))
jest.mock("@/components/connectivity/pair/pair-step", () => ({
  PairStep: ({
    persistPairing,
    onPaired,
  }: {
    persistPairing: (config: unknown) => Promise<void>
    onPaired: () => void
  }) => <button onClick={() => void persistPairing({}).then(onPaired)}>redeem</button>,
}))
jest.mock("@/lib/qr/pair-payload", () => ({
  decodePairPayload: () => ({ kind: "ok", payload: { relay: {}, fingerprint: "sha256:pin" } }),
}))
jest.mock("@/components/settings/common/settings-block", () => ({
  SettingsBlock: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
}))

const lease = {
  id: "lease",
  repository: "owner/repo",
  workflowRef: "main",
  label: "Build",
  state: "ready" as const,
  createdAt: 1,
}

beforeEach(() => {
  jest.restoreAllMocks()
  localStorage.clear()
  desktop = true
  locale = "en"
  store.hosts = []
  store.activeHostId = undefined
  activateHost.mockClear()
  deactivate.mockClear()
  addHost.mockClear()
  jest.spyOn(githubRunnerClient, "preflight").mockResolvedValue({
    ready: true,
    checks: [{ step: "templates", status: "passed", code: "ok" }],
    actorLogin: "builder",
  })
  jest.spyOn(githubRunnerClient, "list").mockResolvedValue([lease])
  jest.spyOn(githubRunnerClient, "refresh").mockResolvedValue(lease)
  jest.spyOn(githubRunnerClient, "cancel").mockResolvedValue({ ...lease, state: "stopping" })
  jest.spyOn(githubRunnerClient, "pairing").mockResolvedValue("cgnp4|transient")
  jest.spyOn(githubRunnerClient, "create").mockResolvedValue({ ...lease, state: "queued" })
})

it("does not call desktop ownership commands in a browser", async () => {
  desktop = false
  render(<GitHubRunnerPanel />)
  expect(await screen.findByText("desktopRequired")).toBeInTheDocument()
  expect(githubRunnerClient.list).not.toHaveBeenCalled()
})

it("starts with repository setup and guides users before showing image inputs", async () => {
  render(<GitHubRunnerPanel />)
  expect(await screen.findByRole("button", { name: "wizard.checkContinue" })).toBeInTheDocument()
  expect(screen.getByLabelText("fields.repository")).toBeInTheDocument()
  expect(screen.queryByLabelText("fields.hostImage")).not.toBeInTheDocument()
  expect(screen.queryByRole("button", { name: "create" })).not.toBeInTheDocument()
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "wizard.checkContinue" })).toBeEnabled()
  )
  fireEvent.click(screen.getByRole("button", { name: "wizard.checkContinue" }))
  expect(await screen.findByText("validation.repository")).toBeInTheDocument()
  expect(githubRunnerClient.create).not.toHaveBeenCalled()
})

it("keeps cancellation pending until the native owner confirms stopped", async () => {
  render(<GitHubRunnerPanel />)
  const row = await screen.findByRole("listitem", { name: "Build" })
  fireEvent.click(within(row).getByText("stop"))
  expect(await screen.findByText("stopPending")).toBeInTheDocument()
  expect(screen.queryByText("state.stopped")).not.toBeInTheDocument()
  expect(deactivate).not.toHaveBeenCalled()
  localStorage.setItem(
    "cognia:github-runner-host-links:v1",
    JSON.stringify({ lease: "paired-host" })
  )
  store.activeHostId = "paired-host"
  jest.mocked(githubRunnerClient.refresh).mockResolvedValue({ ...lease, state: "stopped" })
  fireEvent.click(within(row).getByText("refresh"))
  await waitFor(() => expect(deactivate).toHaveBeenCalled())
})

it("deactivates a failed terminal host and stops automatic refresh", async () => {
  jest.useFakeTimers()
  try {
    localStorage.setItem(
      "cognia:github-runner-host-links:v1",
      JSON.stringify({ lease: "paired-host" })
    )
    store.activeHostId = "paired-host"
    render(<GitHubRunnerPanel />)
    await act(async () => {})
    jest.mocked(githubRunnerClient.refresh).mockResolvedValue({ ...lease, state: "failed" })
    await act(async () => {
      jest.advanceTimersByTime(15_000)
    })
    expect(deactivate).toHaveBeenCalledTimes(1)
    expect(screen.getByText("state.failed")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "stop" })).not.toBeInTheDocument()
    await act(async () => {
      jest.advanceTimersByTime(30_000)
    })
    expect(githubRunnerClient.refresh).toHaveBeenCalledTimes(1)
  } finally {
    jest.useRealTimers()
  }
})

it("uses shared pairing and then reconnects from saved host identity without reusing an invitation", async () => {
  render(<GitHubRunnerPanel />)
  fireEvent.click(await screen.findByRole("button", { name: "connect" }))
  fireEvent.click(await screen.findByRole("button", { name: "redeem" }))
  await waitFor(() => expect(activateHost).toHaveBeenCalledWith("paired-host"))
  expect(addHost).toHaveBeenCalledWith({ label: "Build", config: {} })
  expect(localStorage.getItem("cognia:github-runner-host-links:v1")).not.toContain("cgnp4")
  store.hosts = [{ id: "paired-host" }]
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "refreshAll" }))
  })
  fireEvent.click(screen.getByRole("button", { name: "connect" }))
  await waitFor(() => expect(activateHost).toHaveBeenCalledTimes(2))
  expect(githubRunnerClient.pairing).toHaveBeenCalledTimes(1)
})

it("validates environment fields, requires review, and retains immutable images", async () => {
  render(<GitHubRunnerPanel />)
  await screen.findByRole("listitem", { name: "Build" })
  fireEvent.change(screen.getByLabelText("fields.repository"), {
    target: { value: "https://github.com/owner/repo.git" },
  })
  await continueSetup()
  expect(githubRunnerClient.preflight).toHaveBeenCalledWith({
    repository: "owner/repo",
    workflowRef: "main",
  })
  expect(screen.getByLabelText("fields.label")).toHaveValue("repo")
  const values = {
    ...savedRequest,
    repository: "owner/repo",
    workflowRef: "main",
    label: "Build",
    hostImage: "image:latest",
  }
  for (const [field, value] of Object.entries(values)) {
    if (field !== "repository" && field !== "workflowRef")
      fireEvent.change(screen.getByLabelText(`fields.${field}`), { target: { value } })
  }
  fireEvent.click(screen.getByRole("button", { name: "wizard.reviewContinue" }))
  expect(await screen.findByText("validation.hostImage")).toBeInTheDocument()
  expect(screen.getByLabelText("fields.hostImage")).toHaveFocus()
  expect(githubRunnerClient.create).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText("fields.hostImage"), {
    target: { value: savedRequest.hostImage },
  })
  fireEvent.click(screen.getByRole("button", { name: "wizard.reviewContinue" }))
  expect(await screen.findByRole("button", { name: "create" })).toBeInTheDocument()
  expect(screen.getByText(savedRequest.hostImage)).toBeInTheDocument()
  expect(githubRunnerClient.create).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: "create" }))
  await waitFor(() =>
    expect(githubRunnerClient.create).toHaveBeenCalledWith({
      ...values,
      hostImage: savedRequest.hostImage,
    })
  )
  expect(loadRunnerCreateConfig()).toMatchObject({
    repository: values.repository,
    hostImage: savedRequest.hostImage,
  })
  expect(await screen.findByText("wizard.created")).toBeInTheDocument()
  expect(screen.queryByRole("button", { name: "create" })).not.toBeInTheDocument()
})

it("keeps healthy polling results when another lease fails, including pending cancellation", async () => {
  jest.useFakeTimers()
  try {
    const broken = { ...lease, id: "broken", label: "Broken", state: "stopping" as const }
    const healthy = { ...lease, id: "healthy", label: "Healthy", state: "starting" as const }
    jest.mocked(githubRunnerClient.list).mockResolvedValue([lease, broken, healthy])
    jest.mocked(githubRunnerClient.refresh).mockImplementation(async (id) => {
      if (id === "broken") throw new Error("private native details")
      return { ...(id === "healthy" ? healthy : lease), state: "ready" }
    })
    render(<GitHubRunnerPanel />)
    await act(async () => {})
    await act(async () => {
      jest.advanceTimersByTime(15_000)
    })
    expect(githubRunnerClient.refresh).toHaveBeenCalledTimes(3)
    expect(
      within(screen.getByRole("listitem", { name: "Healthy" })).getByText("state.ready")
    ).toBeInTheDocument()
    expect(
      within(screen.getByRole("listitem", { name: "Broken" })).getByText("stopPending")
    ).toBeInTheDocument()
    expect(screen.getByRole("alert")).toHaveTextContent("operationFailed")
    expect(screen.queryByText("private native details")).not.toBeInTheDocument()
  } finally {
    jest.useRealTimers()
  }
})

const savedRequest = {
  repository: "saved/repo",
  workflowRef: "stable",
  label: "Saved",
  hostImage: `ghcr.io/a/host@sha256:${"a".repeat(64)}`,
  agentBundleImage: `ghcr.io/a/agent@sha256:${"b".repeat(64)}`,
  developmentImage: `ghcr.io/a/dev@sha256:${"c".repeat(64)}`,
  signalingUrl: "wss://signal.example/ws",
  lifetimeMinutes: 90,
}

it("publishes a healthy polling result while another lease is still waiting", async () => {
  jest.useFakeTimers()
  try {
    const slow = { ...lease, id: "slow", label: "Slow", state: "stopping" as const }
    let finishSlow!: (value: typeof slow) => void
    const pending = new Promise<typeof slow>((resolve) => {
      finishSlow = resolve
    })
    jest.mocked(githubRunnerClient.list).mockResolvedValue([lease, slow])
    jest
      .mocked(githubRunnerClient.refresh)
      .mockImplementation((id) =>
        id === "slow" ? pending : Promise.resolve({ ...lease, state: "stopped" })
      )
    render(<GitHubRunnerPanel />)
    await act(async () => {})
    await act(async () => {
      jest.advanceTimersByTime(15_000)
    })
    expect(
      within(screen.getByRole("listitem", { name: "Build" })).getByText("state.stopped")
    ).toBeInTheDocument()
    expect(
      within(screen.getByRole("listitem", { name: "Slow" })).getByText("stopPending")
    ).toBeInTheDocument()
    await act(async () => {
      finishSlow(slow)
    })
  } finally {
    jest.useRealTimers()
  }
})

it("continues manual recovery after one lease refresh rejects", async () => {
  const healthy = { ...lease, id: "healthy", label: "Healthy", state: "queued" as const }
  jest.mocked(githubRunnerClient.list).mockResolvedValue([lease, healthy])
  jest.mocked(githubRunnerClient.refresh).mockImplementation(async (id) => {
    if (id === lease.id) throw new Error("native failure")
    return { ...healthy, state: "ready" }
  })
  render(<GitHubRunnerPanel />)
  await screen.findByRole("listitem", { name: "Healthy" })
  fireEvent.click(screen.getByRole("button", { name: "refreshAll" }))
  await waitFor(() =>
    expect(
      within(screen.getByRole("listitem", { name: "Healthy" })).getByText("state.ready")
    ).toBeInTheDocument()
  )
  expect(screen.getByRole("alert")).toHaveTextContent("operationFailed")
})

it("allows Stop during background refresh and ignores its stale ready result", async () => {
  jest.useFakeTimers()
  try {
    let finishRefresh!: (value: typeof lease) => void
    jest.mocked(githubRunnerClient.refresh).mockReturnValue(
      new Promise((resolve) => {
        finishRefresh = resolve
      })
    )
    render(<GitHubRunnerPanel />)
    await act(async () => {})
    await act(async () => {
      jest.advanceTimersByTime(15_000)
    })
    fireEvent.click(screen.getByRole("button", { name: "stop" }))
    await act(async () => {})
    expect(githubRunnerClient.cancel).toHaveBeenCalledWith(lease.id)
    expect(screen.getByText("stopPending")).toBeInTheDocument()
    await act(async () => {
      finishRefresh(lease)
    })
    expect(screen.getByText("stopPending")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "connect" })).not.toBeInTheDocument()
  } finally {
    jest.useRealTimers()
  }
})

it("bounds polling to four requests and abandons its queued work when Stop begins", async () => {
  jest.useFakeTimers()
  try {
    const rows = Array.from({ length: 7 }, (_, index) => ({
      ...lease,
      id: `lease-${index}`,
      label: `Build ${index}`,
    }))
    const pending = new Map<string, (value: typeof lease) => void>()
    jest.mocked(githubRunnerClient.list).mockResolvedValue(rows)
    jest
      .mocked(githubRunnerClient.refresh)
      .mockImplementation((id) => new Promise((resolve) => pending.set(id, resolve)))
    let finishCancel!: () => void
    jest.mocked(githubRunnerClient.cancel).mockReturnValue(
      new Promise((resolve) => {
        finishCancel = () => resolve({ ...rows[0], state: "stopping" })
      })
    )
    render(<GitHubRunnerPanel />)
    await act(async () => {})
    await act(async () => jest.advanceTimersByTime(45_000))
    expect(githubRunnerClient.refresh).toHaveBeenCalledTimes(4)
    const [firstId, completeFirst] = pending.entries().next().value!
    pending.delete(firstId)
    await act(async () => completeFirst(rows.find((row) => row.id === firstId)!))
    expect(githubRunnerClient.refresh).toHaveBeenCalledTimes(5)
    fireEvent.click(within(screen.getByRole("listitem", { name: "Build 0" })).getByText("stop"))
    expect(githubRunnerClient.cancel).toHaveBeenCalledWith("lease-0")
    // A foreground action invalidates queued work even if it completes before the polls do.
    await act(async () => finishCancel())
    await act(async () => {
      for (const [id, complete] of pending) complete(rows.find((row) => row.id === id)!)
    })
    expect(githubRunnerClient.refresh).toHaveBeenCalledTimes(5)
    expect(
      within(screen.getByRole("listitem", { name: "Build 0" })).getByText("stopPending")
    ).toBeInTheDocument()
  } finally {
    jest.useRealTimers()
  }
})

it("bounds manual refresh and stops submitting queued requests after unmount", async () => {
  const rows = Array.from({ length: 6 }, (_, index) => ({
    ...lease,
    id: `lease-${index}`,
    label: `Build ${index}`,
  }))
  const pending: Array<() => void> = []
  jest.mocked(githubRunnerClient.list).mockResolvedValue(rows)
  jest
    .mocked(githubRunnerClient.refresh)
    .mockImplementation(
      (id) =>
        new Promise((resolve) => pending.push(() => resolve(rows.find((row) => row.id === id)!)))
    )
  const { unmount } = render(<GitHubRunnerPanel />)
  await screen.findByRole("listitem", { name: "Build 0" })
  fireEvent.click(screen.getByRole("button", { name: "refreshAll" }))
  await waitFor(() => expect(githubRunnerClient.refresh).toHaveBeenCalledTimes(4))
  unmount()
  await act(async () => pending.forEach((complete) => complete()))
  expect(githubRunnerClient.refresh).toHaveBeenCalledTimes(4)
})

it("restores the last valid desktop form without overwriting subsequent edits", async () => {
  saveRunnerCreateConfig(savedRequest)
  render(<GitHubRunnerPanel />)
  await waitFor(() => expect(screen.getByLabelText("fields.repository")).toHaveValue("saved/repo"))
  fireEvent.change(screen.getByLabelText("fields.repository"), { target: { value: "edited/repo" } })
  fireEvent.click(screen.getByRole("button", { name: "refreshAll" }))
  await waitFor(() => expect(githubRunnerClient.list).toHaveBeenCalledTimes(2))
  expect(screen.getByLabelText("fields.repository")).toHaveValue("edited/repo")
  expect(loadRunnerCreateConfig()).toEqual(savedRequest)
})

it("does not overwrite input typed before desktop restoration settles", async () => {
  saveRunnerCreateConfig(savedRequest)
  render(<GitHubRunnerPanel />)
  fireEvent.change(screen.getByLabelText("fields.repository"), { target: { value: "typed/repo" } })
  await act(async () => {})
  expect(screen.getByLabelText("fields.repository")).toHaveValue("typed/repo")
})

it("opens the Chinese setup guide through the shared external opener", async () => {
  locale = "zh-CN"
  render(<GitHubRunnerPanel />)
  fireEvent.click(await screen.findByRole("button", { name: "setupGuide" }))
  expect(openExternal).toHaveBeenCalledWith(
    "https://github.com/MaxQian888/cognia-next/blob/dev/deploy/github-runner/README.zh-CN.md"
  )
})

it("dispatches only once when valid creation is submitted again while pending", async () => {
  saveRunnerCreateConfig(savedRequest)
  let finishCreate!: (value: typeof lease) => void
  jest.mocked(githubRunnerClient.create).mockReturnValue(
    new Promise((resolve) => {
      finishCreate = resolve
    })
  )
  render(<GitHubRunnerPanel />)
  await waitFor(() =>
    expect(screen.getByLabelText("fields.repository")).toHaveValue(savedRequest.repository)
  )
  await continueSetup()
  fireEvent.click(screen.getByRole("button", { name: "wizard.reviewContinue" }))
  const form = screen.getByRole("button", { name: "create" }).closest("form")!
  fireEvent.submit(form)
  fireEvent.submit(form)
  expect(githubRunnerClient.create).toHaveBeenCalledTimes(1)
  await act(async () => {
    finishCreate(lease)
  })
})

it("does not deactivate a host when a cancellation resolves after the panel closes", async () => {
  localStorage.setItem(
    "cognia:github-runner-host-links:v1",
    JSON.stringify({ lease: "paired-host" })
  )
  store.activeHostId = "paired-host"
  let finishCancel!: (value: Omit<typeof lease, "state"> & { state: "stopped" }) => void
  jest.mocked(githubRunnerClient.cancel).mockReturnValue(
    new Promise((resolve) => {
      finishCancel = resolve
    })
  )
  const { unmount } = render(<GitHubRunnerPanel />)
  fireEvent.click(await screen.findByRole("button", { name: "stop" }))
  unmount()
  await act(async () => {
    finishCancel({ ...lease, state: "stopped" })
  })
  expect(deactivate).not.toHaveBeenCalled()
})

async function continueSetup() {
  fireEvent.click(screen.getByRole("button", { name: "wizard.checkContinue" }))
  await screen.findByRole("button", { name: "wizard.reviewContinue" })
}

it("keeps failed checks actionable and allows a corrected setup to be checked again", async () => {
  saveRunnerCreateConfig(savedRequest)
  jest.mocked(githubRunnerClient.preflight).mockResolvedValueOnce({
    ready: false,
    checks: [
      { step: "cli", status: "passed", code: "ok" },
      {
        step: "templates",
        status: "failed",
        code: "templates_mismatch",
        file: ".github/workflows/cognia-runner.yml",
      },
    ],
  })
  render(<GitHubRunnerPanel />)
  await waitFor(() =>
    expect(screen.getByLabelText("fields.repository")).toHaveValue(savedRequest.repository)
  )
  fireEvent.click(screen.getByRole("button", { name: "wizard.checkContinue" }))
  expect(await screen.findByText("preflight.codes.templates_mismatch")).toBeInTheDocument()
  expect(screen.getByText(".github/workflows/cognia-runner.yml")).toBeInTheDocument()
  expect(screen.queryByLabelText("fields.hostImage")).not.toBeInTheDocument()
  expect(githubRunnerClient.create).not.toHaveBeenCalled()
  await continueSetup()
  expect(githubRunnerClient.preflight).toHaveBeenCalledTimes(2)
})

it("ignores a stale preflight result when repository details change and keeps Stop available", async () => {
  saveRunnerCreateConfig(savedRequest)
  let finish!: (value: Awaited<ReturnType<typeof githubRunnerClient.preflight>>) => void
  jest.mocked(githubRunnerClient.preflight).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve
    })
  )
  render(<GitHubRunnerPanel />)
  await waitFor(() =>
    expect(screen.getByLabelText("fields.repository")).toHaveValue(savedRequest.repository)
  )
  fireEvent.click(screen.getByRole("button", { name: "wizard.checkContinue" }))
  expect(screen.getByRole("button", { name: "stop" })).toBeEnabled()
  fireEvent.change(screen.getByLabelText("fields.workflowRef"), { target: { value: "other" } })
  await act(async () => finish({ ready: true, checks: [] }))
  expect(screen.queryByLabelText("fields.hostImage")).not.toBeInTheDocument()
  await continueSetup()
  expect(githubRunnerClient.preflight).toHaveBeenLastCalledWith({
    repository: savedRequest.repository,
    workflowRef: "other",
  })
})

it("preserves edits on Back, supports lifetime presets, and resets only the current form", async () => {
  saveRunnerCreateConfig(savedRequest)
  render(<GitHubRunnerPanel />)
  await waitFor(() =>
    expect(screen.getByLabelText("fields.repository")).toHaveValue(savedRequest.repository)
  )
  expect(screen.getByText("wizard.restored")).toBeInTheDocument()
  await continueSetup()
  fireEvent.click(screen.getByRole("radio", { name: "wizard.minutes 120" }))
  expect(screen.getByLabelText("fields.lifetimeMinutes")).toHaveValue(120)
  fireEvent.change(screen.getByLabelText("fields.label"), { target: { value: "Custom" } })
  fireEvent.click(screen.getByRole("button", { name: "wizard.reviewContinue" }))
  fireEvent.click(screen.getByRole("button", { name: "wizard.back" }))
  expect(screen.getByLabelText("fields.label")).toHaveValue("Custom")
  expect(screen.getByLabelText("fields.lifetimeMinutes")).toHaveValue(120)
  fireEvent.click(screen.getByRole("button", { name: "wizard.reset" }))
  expect(screen.getByLabelText("fields.repository")).toHaveValue("")
  expect(screen.queryByText("wizard.restored")).not.toBeInTheDocument()
  expect(loadRunnerCreateConfig()).toEqual(savedRequest)
})

it("sanitizes preflight errors and leaves the form retryable", async () => {
  saveRunnerCreateConfig(savedRequest)
  jest.mocked(githubRunnerClient.preflight).mockRejectedValueOnce(new Error("secret CLI output"))
  render(<GitHubRunnerPanel />)
  await waitFor(() =>
    expect(screen.getByLabelText("fields.repository")).toHaveValue(savedRequest.repository)
  )
  fireEvent.click(screen.getByRole("button", { name: "wizard.checkContinue" }))
  expect(await screen.findByRole("alert")).toHaveTextContent("wizard.checkFailed")
  expect(screen.queryByText("secret CLI output")).not.toBeInTheDocument()
  await continueSetup()
  expect(screen.queryByRole("alert")).not.toBeInTheDocument()
})

it("finishes a pending preflight when the locale changes without restarting native ownership", async () => {
  saveRunnerCreateConfig(savedRequest)
  let finish!: (value: Awaited<ReturnType<typeof githubRunnerClient.preflight>>) => void
  jest.mocked(githubRunnerClient.preflight).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve
    })
  )
  const { rerender } = render(<GitHubRunnerPanel />)
  await waitFor(() =>
    expect(screen.getByLabelText("fields.repository")).toHaveValue(savedRequest.repository)
  )
  const form = screen.getByRole("button", { name: "wizard.checkContinue" }).closest("form")!
  fireEvent.submit(form)
  fireEvent.submit(form)
  expect(githubRunnerClient.preflight).toHaveBeenCalledTimes(1)
  locale = "zh-CN"
  rerender(<GitHubRunnerPanel />)
  await act(async () => finish({ ready: true, checks: [] }))
  expect(screen.getByRole("button", { name: "wizard.reviewContinue" })).toBeEnabled()
  expect(githubRunnerClient.list).toHaveBeenCalledTimes(1)
})
