import { act, renderHook } from "@testing-library/react"
import { toast } from "sonner"
import { useAiDiffReview } from "./use-ai-diff-review"
import type { GitDiff, GitFileChange, GitHunk } from "@/types/git"

let mockSettings: { gitSettings?: unknown }
let mockPii: boolean
let mockClient: { complete: jest.Mock } | null
let mockFindings: { hunk: number; severity: string; note: string }[]

const mockSetAiFinding = jest.fn()
const mockClearAiFindings = jest.fn()
const mockBuildClient = jest.fn((_arg?: unknown) => mockClient)
const mockRedactText = jest.fn((t: string) => ({ redacted: `RED(${t})`, map: {} }))
const mockGenerate = jest.fn((_input?: unknown) => Promise.resolve(mockFindings))

jest.mock("@/lib/ai/generation/utility-client", () => ({
  buildUtilityLlmClient: (arg: unknown) => mockBuildClient(arg),
}))
jest.mock("@cognia/redact", () => ({
  hasNoLeakingPii: () => mockPii,
  redactText: (t: string) => mockRedactText(t),
}))
jest.mock("@/lib/git/ai-review", () => ({
  generateDiffReview: (input: unknown) => mockGenerate(input),
}))
jest.mock("sonner", () => ({
  toast: { info: jest.fn(), warning: jest.fn(), error: jest.fn() },
}))
jest.mock("next-intl", () => ({ useTranslations: () => (k: string) => k }))
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: (sel: (s: unknown) => unknown) => sel({ settings: mockSettings }),
}))
jest.mock("@/stores/git/diff-review-store", () => ({
  useDiffReviewStore: (sel: (s: unknown) => unknown) =>
    sel({ setAiFinding: mockSetAiFinding, clearAiFindings: mockClearAiFindings }),
}))

const mockToast = toast as unknown as { info: jest.Mock; warning: jest.Mock; error: jest.Mock }

function hunk(newStart: number, patch: string): GitHunk {
  return {
    header: `@@ ${newStart}`,
    oldStart: newStart,
    oldLines: 1,
    newStart,
    newLines: 1,
    patch,
    lines: [{ kind: "add", content: `l${newStart}` }],
  }
}

const change: GitFileChange = {
  path: "a.ts",
  origPath: null,
  status: "modified",
  staged: false,
  group: "changes",
}

function diff(hunks: GitHunk[]): GitDiff {
  return { path: "a.ts", oldContent: "", newContent: "", hunks, isBinary: false }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockSettings = { gitSettings: { reviewAI: { enabled: true } } }
  mockPii = true
  mockClient = { complete: jest.fn() }
  mockFindings = [{ hunk: 1, severity: "warning", note: "issue" }]
})

describe("useAiDiffReview", () => {
  it("toasts and skips when there are no hunks", async () => {
    const { result } = renderHook(() => useAiDiffReview("/r", change, diff([])))
    let out: number | null = 0
    await act(async () => {
      out = await result.current.review()
    })
    expect(out).toBeNull()
    expect(mockToast.info).toHaveBeenCalled()
    expect(mockGenerate).not.toHaveBeenCalled()
  })

  it("clears prior findings then writes one setAiFinding per finding", async () => {
    mockFindings = [
      { hunk: 1, severity: "warning", note: "a" },
      { hunk: 2, severity: "critical", note: "b" },
    ]
    const { result } = renderHook(() =>
      useAiDiffReview("/r", change, diff([hunk(1, "p1"), hunk(5, "p2")]))
    )
    let out: number | null = null
    await act(async () => {
      out = await result.current.review()
    })
    expect(out).toBe(2)
    expect(mockClearAiFindings).toHaveBeenCalledWith("/r", "a.ts")
    expect(mockSetAiFinding).toHaveBeenCalledTimes(2)
    expect(mockSetAiFinding).toHaveBeenCalledWith("/r", "a.ts", 0, expect.any(String), {
      severity: "warning",
      note: "a",
    })
    expect(mockSetAiFinding).toHaveBeenCalledWith("/r", "a.ts", 1, expect.any(String), {
      severity: "critical",
      note: "b",
    })
    expect(mockBuildClient).toHaveBeenCalledWith(
      expect.objectContaining({ featureId: "git.reviewDiff" })
    )
  })

  it("skips a finding whose hunk index is out of range", async () => {
    mockFindings = [{ hunk: 5, severity: "info", note: "ghost" }]
    const { result } = renderHook(() => useAiDiffReview("/r", change, diff([hunk(1, "p1")])))
    await act(async () => {
      await result.current.review()
    })
    expect(mockClearAiFindings).toHaveBeenCalled()
    expect(mockSetAiFinding).not.toHaveBeenCalled()
  })

  it("falls back to disabled config when reviewAI is absent", async () => {
    mockSettings = { gitSettings: {} }
    const { result } = renderHook(() => useAiDiffReview("/r", change, diff([hunk(1, "p1")])))
    await act(async () => {
      await result.current.review()
    })
    expect(mockBuildClient).toHaveBeenCalledWith(
      expect.objectContaining({ override: { providerOverride: undefined, model: undefined } })
    )
  })

  it("info-toasts when the review finds nothing", async () => {
    mockFindings = []
    const { result } = renderHook(() => useAiDiffReview("/r", change, diff([hunk(1, "p1")])))
    let out: number | null = null
    await act(async () => {
      out = await result.current.review()
    })
    expect(out).toBe(0)
    expect(mockToast.info).toHaveBeenCalled()
  })

  it("redacts each hunk patch and warns when PII is detected", async () => {
    mockPii = false
    const { result } = renderHook(() => useAiDiffReview("/r", change, diff([hunk(1, "secret")])))
    await act(async () => {
      await result.current.review()
    })
    expect(mockRedactText).toHaveBeenCalledWith("secret")
    expect(mockToast.warning).toHaveBeenCalled()
    const input = mockGenerate.mock.calls[0][0] as { hunks: { patch: string }[] }
    expect(input.hunks[0].patch).toBe("RED(secret)")
  })

  it("does not redact a clean diff", async () => {
    mockPii = true
    const { result } = renderHook(() => useAiDiffReview("/r", change, diff([hunk(1, "clean")])))
    await act(async () => {
      await result.current.review()
    })
    expect(mockRedactText).not.toHaveBeenCalled()
    const input = mockGenerate.mock.calls[0][0] as { hunks: { patch: string }[] }
    expect(input.hunks[0].patch).toBe("clean")
  })

  it("errors when no client can be resolved", async () => {
    mockClient = null
    const { result } = renderHook(() => useAiDiffReview("/r", change, diff([hunk(1, "p1")])))
    let out: number | null = 0
    await act(async () => {
      out = await result.current.review()
    })
    expect(out).toBeNull()
    expect(mockToast.error).toHaveBeenCalled()
    expect(mockGenerate).not.toHaveBeenCalled()
  })

  it("surfaces an error toast + state when generation throws", async () => {
    mockGenerate.mockRejectedValueOnce(new Error("boom"))
    const { result } = renderHook(() => useAiDiffReview("/r", change, diff([hunk(1, "p1")])))
    await act(async () => {
      await result.current.review()
    })
    expect(mockToast.error).toHaveBeenCalled()
    expect(result.current.error).toBe("boom")
  })

  it("forwards the provider/model override", async () => {
    mockSettings = {
      gitSettings: { reviewAI: { enabled: true, providerOverride: "openai", model: "gpt-4o" } },
    }
    const { result } = renderHook(() => useAiDiffReview("/r", change, diff([hunk(1, "p1")])))
    await act(async () => {
      await result.current.review()
    })
    expect(mockBuildClient).toHaveBeenCalledWith(
      expect.objectContaining({ override: { providerOverride: "openai", model: "gpt-4o" } })
    )
  })
})
