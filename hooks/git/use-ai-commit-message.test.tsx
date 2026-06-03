import { act, renderHook } from "@testing-library/react"
import { toast } from "sonner"
import { useAiCommitMessage } from "./use-ai-commit-message"

let mockSettings: { gitSettings?: unknown }
let mockStaged: { path: string; status: string }[]
let mockPii: boolean
let mockClient: { complete: jest.Mock } | null
const mockSetCommitDraft = jest.fn()
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
jest.mock("@/lib/twin/ingest/redact", () => ({
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
    setCommitDraft: mockSetCommitDraft,
  })
  return { useGitStore: store }
})

beforeEach(() => {
  jest.clearAllMocks()
  mockSettings = {
    gitSettings: { commitMessageAI: { enabled: true, conventionalCommits: true } },
  }
  mockStaged = [{ path: "a.ts", status: "modified" }]
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
})
