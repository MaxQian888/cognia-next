import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { renderToString } from "react-dom/server"

import {
  createAgentExecutionHandle,
  type AgentExecutionHandle,
} from "@/lib/ai/agent/execution/agent-execution-handle"
import type { ResolvedAgentExecutionSpec } from "@cognia/agent-config-types/agent-execution"
import {
  AgentExecutionHandleProvider,
  useAgentExecutionHandle,
  useAgentExecutionHandleDirectory,
} from "./agent-execution-handle-provider"

const reloadPlugins = jest.fn().mockResolvedValue(undefined)
const spec: ResolvedAgentExecutionSpec = {
  specVersion: 2,
  identity: { sessionId: "session-1", runId: "run-1", turnId: "turn-1", attemptId: "attempt-1" },
  executionFingerprint: "test-fingerprint",
  executionKind: "agent",
  fallbackPolicy: "none",
  runtimeAdapter: "claude-agent-sdk",
  runtimePolicySource: "explicit",
  modelBindings: { primary: "sonnet" },
  route: { kind: "direct", routePolicy: "direct" },
  hostRef: "desktop-sidecar",
  compatibility: { evidence: "native" },
  capabilities: { effective: [], disabledOptional: [], support: {} },
}

function createTestHandle(reload: AgentExecutionHandle["reloadPlugins"]): AgentExecutionHandle {
  return Object.assign(createAgentExecutionHandle("session-1", spec), { reloadPlugins: reload })
}

const handle = createTestHandle(reloadPlugins)
const replacementHandle = createTestHandle(jest.fn().mockResolvedValue(undefined))

function RegisterHandle() {
  const directory = useAgentExecutionHandleDirectory()
  return <button onClick={() => directory.register(handle)}>register</button>
}

function UseHandle() {
  const liveHandle = useAgentExecutionHandle("session-1")
  return (
    <button disabled={!liveHandle} onClick={() => void liveHandle?.reloadPlugins()}>
      reload
    </button>
  )
}

function RemoveHandle() {
  const directory = useAgentExecutionHandleDirectory()
  return <button onClick={() => directory.unregister("session-1", handle)}>remove</button>
}

function EmptySelection() {
  return <span>{useAgentExecutionHandle(null) ? "found" : "empty"}</span>
}

function ExerciseDirectory() {
  const directory = useAgentExecutionHandleDirectory()
  return (
    <button
      onClick={() => {
        directory.register(handle)
        directory.register(handle)
        directory.unregister("session-1", replacementHandle)
        directory.unregister("missing")
      }}
    >
      exercise
    </button>
  )
}

describe("AgentExecutionHandleProvider", () => {
  beforeEach(() => reloadPlugins.mockClear())

  it("keeps a registered handle available when the routed child changes", async () => {
    const user = userEvent.setup()
    const view = render(
      <AgentExecutionHandleProvider>
        <RegisterHandle />
      </AgentExecutionHandleProvider>
    )

    await user.click(screen.getByRole("button", { name: "register" }))
    view.rerender(
      <AgentExecutionHandleProvider>
        <UseHandle />
      </AgentExecutionHandleProvider>
    )

    await user.click(screen.getByRole("button", { name: "reload" }))
    expect(reloadPlugins).toHaveBeenCalledTimes(1)
  })

  it("notifies consumers when the owning chat session unregisters its handle", async () => {
    const user = userEvent.setup()
    render(
      <AgentExecutionHandleProvider>
        <RegisterHandle />
        <RemoveHandle />
        <UseHandle />
      </AgentExecutionHandleProvider>
    )

    const reload = screen.getByRole("button", { name: "reload" })
    expect(reload).toBeDisabled()
    await user.click(screen.getByRole("button", { name: "register" }))
    expect(reload).toBeEnabled()
    await user.click(screen.getByRole("button", { name: "remove" }))
    expect(reload).toBeDisabled()
  })

  it("ignores duplicate registration, stale cleanup, and missing selections", async () => {
    const user = userEvent.setup()
    render(
      <AgentExecutionHandleProvider>
        <ExerciseDirectory />
        <UseHandle />
        <EmptySelection />
      </AgentExecutionHandleProvider>
    )

    expect(screen.getByText("empty")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "exercise" }))
    expect(screen.getByRole("button", { name: "reload" })).toBeEnabled()
  })

  it("uses a no-op directory when rendered outside the App Shell provider", async () => {
    const user = userEvent.setup()
    const view = render(
      <>
        <ExerciseDirectory />
        <EmptySelection />
        <UseHandle />
      </>
    )
    await user.click(screen.getByRole("button", { name: "exercise" }))
    expect(screen.getByRole("button", { name: "reload" })).toBeDisabled()
    view.unmount()
  })

  it("returns an empty handle snapshot during server rendering", () => {
    expect(
      renderToString(
        <AgentExecutionHandleProvider>
          <EmptySelection />
        </AgentExecutionHandleProvider>
      )
    ).toContain("empty")
  })
})
