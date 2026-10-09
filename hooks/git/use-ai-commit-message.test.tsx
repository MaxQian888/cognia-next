import { act, renderHook } from "@testing-library/react"
import { toast } from "sonner"
import { gitTargetFromRemote } from "@/lib/git/target"
import { useAiCommitMessage } from "./use-ai-commit-message"

let mockSettings: { gitSettings?: unknown }
let mockStaged: { path: string; status: string }[]
let mockPii: boolean
let mockClient: { complete: jest.Mock; stream?: unknown } | null
let mockRuntimeRef: unknown
let mockAgents: Record<string, { name: string }>
let mockDraft: string
const mockSetCommitDraft = jest.fn()
const mockExecuteExternal = jest.fn()
const mockCancelExternal = jest.fn().mockResolvedValue(undefined)
const mockExecuteHost = jest.fn()
const mockInterruptHost = jest.fn().mockResolvedValue(undefined)
const mockGitDiffStagedAll = jest.fn<Promise<string>, [string]>()
const mockComplete = jest.fn().mockResolvedValue("feat: add thing")
const mockBuildClient = jest.fn((_arg?: unknown) => mockClient)
const mockRedactText = jest.fn((t: string) => ({ redacted: `REDACTED(${t})`, map: {} }))

jest.mock("@/lib/git/commands", () => ({
  gitDiffStagedAll: (rp: string) => mockGitDiffStagedAll(rp),
}))
jest.mock("@/lib/ai/generation/utility-client", () => ({
  buildUtilityLlmClient: (arg: unknown) => mockBuildClient(arg),
}))
jest.mock("@cognia/redact", () => ({
  hasNoLeakingPii: () => mockPii,
  redactText: (t: string) => mockRedactText(t),
}))
// Define the toast mock INSIDE the factory to avoid the hoisting TDZ (the
// factory is evaluated at module-load, before const initializers run).
jest.mock("sonner", () => ({
  toast: { info: jest.fn(), warning: jest.fn(), error: jest.fn() },
}))
jest.mock("next-intl", () => ({ useTranslations: () => (k: string) => k }))

const mockToast = toast as unknown as {
  info: jest.Mock
  warning: jest.Mock
  error: jest.Mock
}
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: (sel: (s: unknown) => unknown) => sel({ settings: mockSettings }),
}))
jest.mock("@/stores/git/git-store", () => {
  const store = (sel: (s: unknown) => unknown) => sel({ setCommitDraft: mockSetCommitDraft })
  ;(store as unknown as { getState: () => unknown }).getState = () => ({
    status: { staged: mockStaged },
    commitDraft: { "/repo": mockDraft },
    setCommitDraft: mockSetCommitDraft,
  })
  return { useGitStore: store }
})
jest.mock("@/stores/chat", () => ({
  useChatStore: (sel: (s: unknown) => unknown) => sel({ activeSessionId: "s1" }),
}))
jest.mock("@/stores/agent/agent-runtime-store", () => ({
  useRuntimeRefForSession: () => mockRuntimeRef,
}))
jest.mock("@/stores/agent/external-agent-store", () => ({
  useExternalAgentStore: (sel: (s: unknown) => unknown) => sel({ agents: mockAgents }),
}))
jest.mock("@/lib/ai/agent/external/manager", () => ({
  executeOnExternalAgent: (...args: unknown[]) => mockExecuteExternal(...args),
  getExternalAgentManager: () => ({ cancel: mockCancelExternal }),
}))
jest.mock("@/lib/ai/agent/external/runtimes/remote/remote-execute", () => ({
  executeOnRemoteHostAgent: (...args: unknown[]) => mockExecuteHost(...args),
  interruptRemoteHostAgent: (...args: unknown[]) => mockInterruptHost(...args),
}))

function agentResult(finalResponse: string, success = true) {
  return {
    success,
    sessionId: "x",
    finalResponse,
    messages: [],
    steps: [],
    toolCalls: [],
    duration: 1,
    ...(success ? {} : { error: "agent broke" }),
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockSettings = {
    gitSettings: { commitMessageAI: { enabled: true, conventionalCommits: true } },
  }
  mockStaged = [{ path: "a.ts", status: "modified" }]
  mockRuntimeRef = { kind: "builtin" }
  mockAgents = {}
  mockDraft = ""
  mockPii = true
  mockClient = { complete: mockComplete }
  mockComplete.mockResolvedValue("feat: add thing")
  mockGitDiffStagedAll.mockResolvedValue("diff --git a/a.ts b/a.ts\n+x")
})

describe("useAiCommitMessage", () => {
  it("toasts and returns null when nothing is staged", async () => {
    mockGitDiffStagedAll.mockResolvedValue("   ")
    const { result } = renderHook(() => useAiCommitMessage("/repo"))
    let out: string | null = "x"
    await act(async () => {
      out = await result.current.generate()
    })
    expect(out).toBeNull()
    expect(mockToast.info).toHaveBeenCalled()
    expect(mockComplete).not.toHaveBeenCalled()
  })

  it("generates and writes the draft on success", async () => {
    mockPii = true // hasNoLeakingPii returns true → no redaction
    const { result } = renderHook(() => useAiCommitMessage("/repo"))
    let out: string | null = null
    await act(async () => {
      out = await result.current.generate()
    })
    expect(out).toBe("feat: add thing")
    expect(mockSetCommitDraft).toHaveBeenCalledWith("/repo", "feat: add thing")
    expect(mockBuildClient).toHaveBeenCalledWith(
      expect.objectContaining({ featureId: "git.commitMessage" })
    )
  })

  it("forwards the provider/model override to the client builder", async () => {
    mockSettings = {
      gitSettings: {
        commitMessageAI: {
          enabled: true,
          conventionalCommits: true,
          providerOverride: "openai",
          model: "gpt-4o",
        },
      },
    }
    const { result } = renderHook(() => useAiCommitMessage("/repo"))
    await act(async () => {
      await result.current.generate()
    })
    expect(mockBuildClient).toHaveBeenCalledWith(
      expect.objectContaining({
        override: { providerOverride: "openai", model: "gpt-4o" },
      })
    )
  })

  it("errors when no model client can be resolved", async () => {
    mockClient = null
    const { result } = renderHook(() => useAiCommitMessage("/repo"))
    let out: string | null = "x"
    await act(async () => {
      out = await result.current.generate()
    })
    expect(out).toBeNull()
    expect(mockToast.error).toHaveBeenCalled()
  })

  it("redacts the diff and warns when PII is detected", async () => {
    mockPii = false // hasNoLeakingPii false → leak present → redact
    const { result } = renderHook(() => useAiCommitMessage("/repo"))
    await act(async () => {
      await result.current.generate()
    })
    expect(mockRedactText).toHaveBeenCalled()
    expect(mockToast.warning).toHaveBeenCalled()
    const promptArg = mockComplete.mock.calls[0][0] as string
    expect(promptArg).toContain("REDACTED(")
  })

  it("does not redact when the diff is clean", async () => {
    mockPii = true
    const { result } = renderHook(() => useAiCommitMessage("/repo"))
    await act(async () => {
      await result.current.generate()
    })
    expect(mockRedactText).not.toHaveBeenCalled()
    expect(mockToast.warning).not.toHaveBeenCalled()
  })

  it("surfaces an error toast when generation throws", async () => {
    mockComplete.mockRejectedValue(new Error("boom"))
    const { result } = renderHook(() => useAiCommitMessage("/repo"))
    let out: string | null = "x"
    await act(async () => {
      out = await result.current.generate()
    })
    expect(out).toBeNull()
    expect(mockToast.error).toHaveBeenCalled()
    expect(result.current.error).toBe("boom")
  })

  it("passes the user's draft along as a hint", async () => {
    mockDraft = "fix login race"
    const { result } = renderHook(() => useAiCommitMessage("/repo"))
    await act(async () => {
      await result.current.generate()
    })
    expect(mockComplete.mock.calls[0][0]).toContain("fix login race")
  })

  it("streams into preview on a streaming client and clears it after", async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    mockClient = {
      complete: mockComplete,
      stream: async function* () {
        yield "feat: str"
        await gate
        yield "eamed"
      },
    }
    const { result } = renderHook(() => useAiCommitMessage("/repo"))
    let pending: Promise<string | null> = Promise.resolve(null)
    await act(async () => {
      pending = result.current.generate()
      await Promise.resolve()
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(result.current.preview).toBe("feat: str")
    expect(result.current.generating).toBe(true)
    await act(async () => {
      release()
      await pending
    })
    expect(mockSetCommitDraft).toHaveBeenCalledWith("/repo", "feat: streamed")
    expect(result.current.preview).toBe("")
    expect(result.current.generating).toBe(false)
  })

  it("reports no agent name on the built-in lane", () => {
    const { result } = renderHook(() => useAiCommitMessage("/repo"))
    expect(result.current.agentName).toBeNull()
  })

  describe("on the selected agent", () => {
    beforeEach(() => {
      mockRuntimeRef = { kind: "external", agentId: "codex" }
      mockAgents = { codex: { name: "Codex" } }
      mockExecuteExternal.mockResolvedValue(
        agentResult("Looked at a.ts.\n<commit-message>feat(a): agent wrote it</commit-message>")
      )
    })

    it("names the agent", () => {
      const { result } = renderHook(() => useAiCommitMessage("/repo"))
      expect(result.current.agentName).toBe("Codex")
    })

    it("runs the local agent read-only in the repository and keeps only the message", async () => {
      const { result } = renderHook(() => useAiCommitMessage("/repo"))
      let out: string | null = null
      await act(async () => {
        out = await result.current.generate()
      })
      expect(out).toBe("feat(a): agent wrote it")
      expect(mockSetCommitDraft).toHaveBeenCalledWith("/repo", "feat(a): agent wrote it")
      expect(mockBuildClient).not.toHaveBeenCalled()
      const [prompt, options] = mockExecuteExternal.mock.calls[0]
      expect(prompt).toContain("diff --git a/a.ts b/a.ts")
      expect(options).toMatchObject({
        agentId: "codex",
        permissionMode: "plan",
        workingDirectory: "/repo",
      })
    })

    it("does not hand a paired host's repository path to a local agent", async () => {
      const remoteRoot = gitTargetFromRemote("w")
      const { result } = renderHook(() => useAiCommitMessage(remoteRoot))
      await act(async () => {
        await result.current.generate()
      })
      expect(mockExecuteExternal.mock.calls[0][1]).not.toHaveProperty("workingDirectory")
    })

    it("sends the redacted diff to the agent", async () => {
      mockPii = false
      const { result } = renderHook(() => useAiCommitMessage("/repo"))
      await act(async () => {
        await result.current.generate()
      })
      expect(mockExecuteExternal.mock.calls[0][0]).toContain("REDACTED(")
      expect(mockToast.warning).toHaveBeenCalledTimes(1)
    })

    it("falls back to the model when the selected agent was removed", async () => {
      mockAgents = {}
      const { result } = renderHook(() => useAiCommitMessage("/repo"))
      await act(async () => {
        await result.current.generate()
      })
      expect(mockExecuteExternal).not.toHaveBeenCalled()
      expect(mockComplete).toHaveBeenCalled()
      expect(result.current.agentName).toBeNull()
    })

    it("uses the model when the setting says so", async () => {
      mockSettings = {
        gitSettings: {
          commitMessageAI: { enabled: true, conventionalCommits: true, source: "model" },
        },
      }
      const { result } = renderHook(() => useAiCommitMessage("/repo"))
      await act(async () => {
        await result.current.generate()
      })
      expect(mockExecuteExternal).not.toHaveBeenCalled()
      expect(mockComplete).toHaveBeenCalled()
    })

    it("toasts the agent's failure", async () => {
      mockExecuteExternal.mockResolvedValue(agentResult("", false))
      const { result } = renderHook(() => useAiCommitMessage("/repo"))
      let out: string | null = "x"
      await act(async () => {
        out = await result.current.generate()
      })
      expect(out).toBeNull()
      expect(result.current.error).toBe("agent broke")
      expect(mockToast.error).toHaveBeenCalled()
      expect(mockSetCommitDraft).not.toHaveBeenCalled()
    })

    it("cancels quietly, leaving the draft alone", async () => {
      mockExecuteExternal.mockImplementation(() => new Promise(() => {}))
      const { result } = renderHook(() => useAiCommitMessage("/repo"))
      let pending: Promise<string | null> = Promise.resolve("x")
      await act(async () => {
        pending = result.current.generate()
        await new Promise((r) => setTimeout(r, 0))
      })
      expect(result.current.generating).toBe(true)
      let out: string | null = "x"
      await act(async () => {
        result.current.cancel()
        out = await pending
      })
      expect(out).toBeNull()
      expect(result.current.generating).toBe(false)
      expect(mockToast.error).not.toHaveBeenCalled()
      expect(mockSetCommitDraft).not.toHaveBeenCalled()
    })

    it("runs a host configuration on the host", async () => {
      mockRuntimeRef = {
        kind: "host",
        configId: "c1",
        revision: "r1",
        lifecycleGeneration: 2,
        name: "Studio Codex",
      }
      mockExecuteHost.mockResolvedValue(agentResult("<commit-message>fix: host</commit-message>"))
      const { result } = renderHook(() => useAiCommitMessage("/repo"))
      expect(result.current.agentName).toBe("Studio Codex")
      await act(async () => {
        await result.current.generate()
      })
      expect(mockExecuteHost.mock.calls[0][1].stamp).toEqual({
        configId: "c1",
        revision: "r1",
        lifecycleGeneration: 2,
      })
      expect(mockSetCommitDraft).toHaveBeenCalledWith("/repo", "fix: host")
    })
  })
})
