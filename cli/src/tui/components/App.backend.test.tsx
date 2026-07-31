/**
 * The startup backend lifecycle: trust → connect → chat, and the failure page.
 *
 * These cover the behaviour that replaced "spawn lazily on the first turn": the
 * process now comes up while the composer is still closed, so a missing binary
 * or sandbox is reported with the user's hands free instead of after they have
 * typed and submitted a message.
 */
import React from "react"
import { act, render } from "@testing-library/react"
import { __fireInput, __resetInk } from "ink"

import { App } from "./App"
import { DEFAULT_RESOLVED_CONFIG } from "../../config/schema"
import type { ResolvedConfig } from "../../config/schema"
import { externalCapabilities } from "../runtime/backend-capabilities"
import { disconnectBackend } from "../runtime/backend-controller"
import type {
  BackendConnectResult,
  BackendConnectStage,
  connectBackend,
} from "../runtime/backend-controller"
import type { BackendInstallOption } from "../state/types"

jest.mock("../input/history-store", () => ({
  loadHistory: () => [],
  appendHistory: jest.fn(),
}))

// The real `disconnectBackend` reaches for the shared manager; stub it so the
// reclaim/cancel paths are observable without touching a live process.
jest.mock("../runtime/backend-controller", () => ({
  ...jest.requireActual("../runtime/backend-controller"),
  disconnectBackend: jest.fn(async () => undefined),
}))

const config: ResolvedConfig = {
  ...DEFAULT_RESOLVED_CONFIG,
  cwd: "/work",
  agentBackend: "codex",
}

const ok = (): BackendConnectResult => ({
  ok: true,
  connection: {
    backend: "codex",
    presetId: "codex-app-server",
    agentId: "cli-backend-s1",
    command: "codex",
    capabilities: externalCapabilities({ backend: "codex", presetId: "codex-app-server" }),
  },
})

const failed = (): BackendConnectResult => ({
  ok: false,
  failure: {
    kind: "command",
    stage: "command",
    message: "\"codex\" isn't installed or isn't on PATH.",
    hint: "Install codex, then run /backend codex to retry.",
  },
})

/** A missing-binary failure that carries the command, so an install can be offered. */
const failedInstallable = (): BackendConnectResult => ({
  ok: false,
  failure: {
    kind: "command",
    stage: "command",
    message: "\"copilot\" isn't installed or isn't on PATH.",
    command: "copilot",
  },
})

const installOption: BackendInstallOption = {
  command: "copilot",
  name: "GitHub Copilot CLI",
  method: {
    kind: "npm",
    label: "npm",
    display: "npm install -g @github/copilot",
    command: "npm",
    args: ["install", "-g", "@github/copilot"],
    requires: ["npm"],
  },
}

/** A connect that reports stages then settles with `result`. */
function fakeConnect(result: () => BackendConnectResult, stages: BackendConnectStage[] = []) {
  const fn: typeof connectBackend = async (deps) => {
    for (const stage of stages) deps.onStage?.(stage)
    return result()
  }
  return jest.fn(fn)
}

function renderApp(
  connectBackendFn: ReturnType<typeof fakeConnect>,
  overrides: Partial<React.ComponentProps<typeof App>> = {}
) {
  return render(
    <App
      config={config}
      sessionId="s1"
      trusted={false}
      home="/home/u/.cognia"
      trustFolderFn={() => undefined}
      connectBackendFn={connectBackendFn}
      createExternalSession={
        (() => ({
          sessionId: "ses",
          send: async () => ({
            text: "hi",
            messageId: "m",
            a2uiSurfaces: {},
            a2uiSurfaceOrder: [],
          }),
          close: async () => undefined,
        })) as React.ComponentProps<typeof App>["createExternalSession"]
      }
      {...overrides}
    />
  )
}

/** Accept the trust gate ("Yes, proceed"). */
function acceptTrust() {
  act(() => __fireInput("", { return: true }))
}

function type(text: string) {
  for (const char of text) act(() => __fireInput(char))
}

function submit() {
  act(() => __fireInput("", { return: true }))
}

async function settle() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe("App — external backend startup", () => {
  beforeEach(() => {
    __resetInk()
    ;(disconnectBackend as jest.Mock).mockClear()
  })

  it("does not connect until the folder is trusted", async () => {
    const connect = fakeConnect(ok)
    const { container } = renderApp(connect)

    // The sandbox hands the cwd to the agent as a writable root, so an untrusted
    // folder must never have a process spawned against it.
    expect(connect).not.toHaveBeenCalled()
    expect(container.textContent).toContain("Do you trust the files in")

    acceptTrust()
    await settle()
    expect(connect).toHaveBeenCalledTimes(1)
  })

  it("shows the staged progress line while the agent comes up", async () => {
    // A connect that never settles leaves the UI in the connecting phase.
    const pending: typeof connectBackend = async (deps) => {
      deps.onStage?.("sandbox")
      return new Promise<BackendConnectResult>(() => {})
    }
    const { container } = renderApp(jest.fn(pending))

    acceptTrust()
    await settle()

    const text = container.textContent ?? ""
    expect(text).toContain("starting codex")
    expect(text).toContain("checking sandbox")
    // No composer yet — a message must not be typeable into a backend that has
    // not started.
    expect(text).not.toContain("esc to interrupt")
  })

  it("enters the chat once the agent is live", async () => {
    const connect = fakeConnect(ok, ["preset", "command", "sandbox", "launch"])
    const { container } = renderApp(connect)

    acceptTrust()
    await settle()

    expect(container.textContent).not.toContain("starting codex")
    // The banner reports who is actually answering, not the built-in provider.
    expect(container.textContent).toContain("codex (codex-app-server)")
  })

  it("does not open a stale model list after switching backends", async () => {
    let resolveModels: ((models: Array<{ id: string }>) => void) | undefined
    const listExternalModels = jest.fn(
      () =>
        new Promise<Array<{ id: string }>>((resolve) => {
          resolveModels = resolve
        })
    )
    const { container } = renderApp(fakeConnect(ok), {
      trusted: true,
      listExternalModels,
    })
    await settle()

    type("/model")
    submit()
    expect(listExternalModels).toHaveBeenCalledWith("cli-backend-s1")

    type("/backend builtin")
    submit()
    await settle()
    await act(async () => resolveModels?.([{ id: "stale-codex-model" }]))

    expect(container.textContent).not.toContain("stale-codex-model")
    expect(container.textContent).not.toContain("Switch model")
  })

  it("reports external model-list failures instead of leaking a rejection", async () => {
    const { container } = renderApp(fakeConnect(ok), {
      trusted: true,
      listExternalModels: jest.fn(async () => {
        throw new Error("catalog unavailable")
      }),
    })
    await settle()

    type("/model")
    submit()
    await settle()

    expect(container.textContent).toContain("codex did not report any models")
  })

  it("shows a recovery page instead of a composer when the agent cannot start", async () => {
    const { container } = renderApp(fakeConnect(failed))

    acceptTrust()
    await settle()

    const text = container.textContent ?? ""
    expect(text).toContain("Couldn't start codex — failed while locating executable.")
    expect(text).toContain("isn't installed")
    expect(text).toContain("Retry")
    expect(text).toContain("Use the built-in agent instead")
  })

  it("retries the connect from the failure page", async () => {
    const connect = jest
      .fn<ReturnType<typeof connectBackend>, Parameters<typeof connectBackend>>()
      .mockResolvedValueOnce(failed())
      .mockResolvedValueOnce(ok())
    const { container } = renderApp(connect as ReturnType<typeof fakeConnect>)

    acceptTrust()
    await settle()
    expect(container.textContent).toContain("Retry")

    // "Retry" is the first choice.
    act(() => __fireInput("", { return: true }))
    await settle()

    expect(connect).toHaveBeenCalledTimes(2)
    expect(container.textContent).not.toContain("Couldn't start codex")
  })

  it("falls back to the built-in agent only when the user picks it, and says so", async () => {
    const { container } = renderApp(fakeConnect(failed))

    acceptTrust()
    await settle()

    // Move to "Use the built-in agent instead" and choose it.
    act(() => __fireInput("", { downArrow: true }))
    act(() => __fireInput("", { return: true }))
    await settle()

    const text = container.textContent ?? ""
    expect(text).toContain("Switched to the built-in agent")
    expect(text).toContain("codex could not start")
  })

  it("goes straight to chat on the built-in backend without connecting", async () => {
    const connect = fakeConnect(ok)
    renderApp(connect, { config: { ...config, agentBackend: "builtin" } })

    acceptTrust()
    await settle()

    expect(connect).not.toHaveBeenCalled()
  })

  it("connects immediately in an already-trusted folder, with no gate", async () => {
    // A trusted folder skips the trust gate, but an external backend still has
    // to come up first — so it enters the staged connect rather than a composer
    // whose first message would fail (the old lazy-spawn behaviour).
    const connect = fakeConnect(ok, ["preset", "command", "sandbox", "launch"])
    const { container } = renderApp(connect, { trusted: true })

    await settle()

    expect(container.textContent).not.toContain("Do you trust the files in")
    expect(connect).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain("codex (codex-app-server)")
  })

  it("cancels a hanging connect with Esc and reclaims the half-connected agent", async () => {
    const pending: typeof connectBackend = async (deps) => {
      deps.onStage?.("sandbox")
      return new Promise<BackendConnectResult>(() => {})
    }
    const { container } = renderApp(jest.fn(pending), { trusted: true })

    await settle()
    expect(container.textContent).toContain("starting codex")

    act(() => __fireInput("", { escape: true }))
    await settle()

    const text = container.textContent ?? ""
    expect(text).toContain("Couldn't start codex")
    expect(text).toContain("Connection cancelled")
    // Reclaims whatever the in-flight connect registered under the stable id.
    expect(disconnectBackend).toHaveBeenCalledWith({ agentId: "cli-backend-s1" })
  })

  it("offers to install a missing agent and shows the install running", async () => {
    const runInstallFn: React.ComponentProps<typeof App>["runInstallFn"] = async ({ onLine }) => {
      onLine("added 1 package")
      // Never settles, so the installing page stays up for the assertion.
      return new Promise<never>(() => {})
    }
    const { container } = renderApp(fakeConnect(failedInstallable), {
      trusted: true,
      resolveInstallOptionFn: async () => installOption,
      runInstallFn,
    })

    await settle()
    expect(container.textContent).toContain("Install GitHub Copilot CLI (npm)")

    // "Install" is the first choice — Enter runs it.
    act(() => __fireInput("", { return: true }))
    await settle()

    const text = container.textContent ?? ""
    expect(text).toContain("Installing GitHub Copilot CLI")
    expect(text).toContain("npm install -g @github/copilot")
    expect(text).toContain("added 1 package")
  })

  it("reconnects automatically after a successful install", async () => {
    const connect = jest
      .fn<ReturnType<typeof connectBackend>, Parameters<typeof connectBackend>>()
      .mockResolvedValueOnce(failedInstallable())
      .mockResolvedValueOnce(ok())
    const runInstallFn: React.ComponentProps<typeof App>["runInstallFn"] = async () => ({
      ok: true,
      exitCode: 0,
      signal: null,
    })
    const { container } = renderApp(connect as ReturnType<typeof fakeConnect>, {
      trusted: true,
      resolveInstallOptionFn: async () => installOption,
      runInstallFn,
    })

    await settle()
    act(() => __fireInput("", { return: true }))
    // Install → reconnect → chat is a multi-hop async chain.
    await settle()
    await settle()
    await settle()

    expect(connect).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain("codex (codex-app-server)")
  })

  it("shows an inline error and keeps the install option when the install fails", async () => {
    const runInstallFn: React.ComponentProps<typeof App>["runInstallFn"] = async () => ({
      ok: false,
      exitCode: 1,
      signal: null,
    })
    const { container } = renderApp(fakeConnect(failedInstallable), {
      trusted: true,
      resolveInstallOptionFn: async () => installOption,
      runInstallFn,
    })

    await settle()
    act(() => __fireInput("", { return: true }))
    await settle()
    await settle()

    const text = container.textContent ?? ""
    expect(text).toContain("Couldn't install GitHub Copilot CLI")
    // Back on the failure page — the install is still offered for a retry.
    expect(text).toContain("Install GitHub Copilot CLI (npm)")
  })

  it("reclaims the external process on unmount", async () => {
    const connect = fakeConnect(ok, ["preset", "command", "sandbox", "launch"])
    const { unmount } = renderApp(connect, { trusted: true })

    await settle()
    ;(disconnectBackend as jest.Mock).mockClear()
    unmount()
    // Teardown now runs through the lifecycle owner, which first waits out any
    // connect still settling — so the reclaim lands on the next tick rather
    // than synchronously. It still lands.
    await settle()

    // The controller owns the process it started, so teardown must remove it.
    expect(disconnectBackend).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "cli-backend-s1" })
    )
  })
})
