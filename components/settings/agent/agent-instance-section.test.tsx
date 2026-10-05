/**
 * AgentInstanceSection — one configuration among the others of its runtime
 * (ADR-0216): where its state lives, its session limit, its siblings and what
 * it shares with them.
 */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TooltipProvider } from "@/components/ui/tooltip"
import { AgentInstanceSection } from "./agent-instance-section"
import type { LifecycleExternalAgentConfig } from "@/stores/agent/external-agent-store"
import type { ExternalAgentStateRootInfo } from "@/lib/ai/agent/external/lifecycle/state-root"

const mockStateRootInfo = jest.fn<Promise<ExternalAgentStateRootInfo | null>, [string]>()
jest.mock("@/lib/ai/agent/external/lifecycle/state-root", () => ({
  getExternalAgentStateRootInfo: (id: string) => mockStateRootInfo(id),
}))
const mockReveal = jest.fn(async (_path: string) => true)
jest.mock("@/lib/native/opener", () => ({
  revealItemInDir: (path: string) => mockReveal(path),
}))
const mockIsTauri = jest.fn(() => true)
jest.mock("@/lib/tauri", () => ({
  isTauri: () => mockIsTauri(),
}))

function codex(
  id: string,
  overrides: Partial<LifecycleExternalAgentConfig> = {}
): LifecycleExternalAgentConfig {
  return {
    id,
    name: id,
    protocol: "codex-app-server",
    transport: "stdio",
    enabled: true,
    process: { command: "codex", args: ["app-server"] },
    defaultPermissionMode: "default",
    metadata: { preset: "codex-app-server" },
    timeout: 1000,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  } as LifecycleExternalAgentConfig
}

function renderSection(
  agent: LifecycleExternalAgentConfig,
  allAgents: LifecycleExternalAgentConfig[],
  draft: { isolation?: "shared" | "isolated"; limit?: string } = {}
) {
  const onDraftIsolationChange = jest.fn()
  const onDraftSessionLimitChange = jest.fn()
  const onOpenAgent = jest.fn()
  render(
    <TooltipProvider>
      <AgentInstanceSection
        agent={agent}
        allAgents={allAgents}
        draftIsolation={draft.isolation ?? agent.stateIsolation ?? "shared"}
        onDraftIsolationChange={onDraftIsolationChange}
        draftSessionLimit={draft.limit ?? ""}
        onDraftSessionLimitChange={onDraftSessionLimitChange}
        onOpenAgent={onOpenAgent}
      />
    </TooltipProvider>
  )
  return { onDraftIsolationChange, onDraftSessionLimitChange, onOpenAgent }
}

beforeEach(() => {
  mockStateRootInfo.mockReset()
  mockReveal.mockClear()
  mockIsTauri.mockReturnValue(true)
})

describe("AgentInstanceSection", () => {
  it("shows an isolated configuration's own folder, its size, and reveals it", async () => {
    mockStateRootInfo.mockResolvedValue({
      path: "/data/cognia/external-agents/work",
      exists: true,
      bytes: 2048,
    })
    const user = userEvent.setup()
    const work = codex("work", { stateIsolation: "isolated" })
    renderSection(work, [work])
    expect(screen.getByTestId("state-folder-loading")).toBeInTheDocument()
    const folder = await screen.findByTestId("state-folder")
    expect(mockStateRootInfo).toHaveBeenCalledWith("work")
    expect(folder).toHaveTextContent("/data/cognia/external-agents/work")
    expect(folder).toHaveTextContent("2.0 KB")
    await user.click(screen.getByTestId("state-folder-reveal"))
    expect(mockReveal).toHaveBeenCalledWith("/data/cognia/external-agents/work")
  })

  it("says the folder is created on first launch, with nothing to reveal yet", async () => {
    mockStateRootInfo.mockResolvedValue({ path: "/data/x", exists: false, bytes: 0 })
    const work = codex("work", { stateIsolation: "isolated" })
    renderSection(work, [work])
    expect(await screen.findByTestId("state-folder")).toHaveTextContent("Created on first launch")
    expect(screen.queryByTestId("state-folder-reveal")).not.toBeInTheDocument()
  })

  it("offers no reveal button outside the desktop shell", async () => {
    mockIsTauri.mockReturnValue(false)
    mockStateRootInfo.mockResolvedValue({ path: "/data/x", exists: true, bytes: 1 })
    const work = codex("work", { stateIsolation: "isolated" })
    renderSection(work, [work])
    await screen.findByTestId("state-folder")
    expect(screen.queryByTestId("state-folder-reveal")).not.toBeInTheDocument()
  })

  it("says where the folder is when this machine does not own it", async () => {
    mockStateRootInfo.mockResolvedValue(null)
    const work = codex("work", { stateIsolation: "isolated" })
    renderSection(work, [work])
    expect(await screen.findByTestId("state-folder-remote")).toBeInTheDocument()
  })

  it("reports a folder that cannot be read instead of spinning forever", async () => {
    mockStateRootInfo.mockRejectedValue(new Error("permission denied"))
    const work = codex("work", { stateIsolation: "isolated" })
    renderSection(work, [work])
    expect(await screen.findByTestId("state-folder-error")).toHaveTextContent("permission denied")
  })

  it("does not look for a folder for a configuration on the shared state", () => {
    const personal = codex("personal", { stateIsolation: "shared" })
    renderSection(personal, [personal])
    expect(mockStateRootInfo).not.toHaveBeenCalled()
    expect(screen.queryByTestId("state-folder-loading")).not.toBeInTheDocument()
  })

  it("routes the isolation choice into the draft and warns about signing in again", async () => {
    const user = userEvent.setup()
    const personal = codex("personal", { stateIsolation: "shared" })
    const { onDraftIsolationChange } = renderSection(personal, [personal], {
      isolation: "isolated",
    })
    expect(screen.getByTestId("state-isolation-sign-in-warning")).toBeInTheDocument()
    await user.click(screen.getByTestId("state-isolation-shared"))
    expect(onDraftIsolationChange).toHaveBeenCalledWith("shared")
  })

  it("names the configurations that share this one's login and history", () => {
    const a = codex("Personal", { stateIsolation: "shared" })
    const b = codex("Scratch", { stateIsolation: "shared" })
    const c = codex("Work", { stateIsolation: "isolated" })
    renderSection(a, [a, b, c])
    const warning = screen.getByTestId("instance-shared-state-warning")
    expect(warning).toHaveTextContent("Scratch")
    // An isolated sibling shares nothing.
    expect(warning).not.toHaveTextContent("Work")
  })

  it("says nothing about sharing when this configuration is isolated", async () => {
    mockStateRootInfo.mockResolvedValue(null)
    const a = codex("Personal", { stateIsolation: "isolated" })
    const b = codex("Scratch", { stateIsolation: "shared" })
    renderSection(a, [a, b])
    await screen.findByTestId("state-folder-remote")
    expect(screen.queryByTestId("instance-shared-state-warning")).not.toBeInTheDocument()
  })

  it("lists the runtime's other configurations with what differs, and opens one", async () => {
    const user = userEvent.setup()
    const a = codex("Personal", { stateIsolation: "shared" })
    const b = codex("Planner", { stateIsolation: "shared", defaultPermissionMode: "plan" })
    const c = codex("Twin", { stateIsolation: "shared" })
    const other = codex("Qwen", {
      metadata: { preset: "qwen" },
      process: { command: "qwen", args: [] },
    })
    const { onOpenAgent } = renderSection(a, [a, b, c, other])
    const siblings = screen.getByTestId("instance-siblings")
    expect(siblings).toHaveTextContent("Other configurations of this runtime (2)")
    expect(screen.getByTestId("instance-sibling-Planner")).toHaveTextContent("Plan")
    expect(screen.getByTestId("instance-sibling-Twin")).toHaveTextContent("Same settings")
    expect(screen.queryByTestId("instance-sibling-Qwen")).not.toBeInTheDocument()
    await user.click(screen.getByTestId("instance-sibling-Planner"))
    expect(onOpenAgent).toHaveBeenCalledWith("Planner")
  })

  it("routes the session limit as typed into the draft", async () => {
    const user = userEvent.setup()
    const a = codex("Personal")
    const { onDraftSessionLimitChange } = renderSection(a, [a])
    const input = screen.getByTestId("instance-session-limit")
    expect(input).toHaveAttribute("placeholder", "Unlimited")
    await user.type(input, "3")
    expect(onDraftSessionLimitChange).toHaveBeenLastCalledWith("3")
  })

  it("has no local state to separate for a network agent", () => {
    const remote = codex("Remote", {
      transport: "http",
      protocol: "acp",
      process: undefined,
      metadata: {},
      network: { endpoint: "https://agents.example.com" },
    })
    renderSection(remote, [remote])
    expect(screen.getByTestId("instance-state-remote")).toBeInTheDocument()
    expect(screen.queryByTestId("state-isolation-field")).not.toBeInTheDocument()
    expect(mockStateRootInfo).not.toHaveBeenCalled()
  })
})
