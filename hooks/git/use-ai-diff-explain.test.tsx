import { act, renderHook } from "@testing-library/react"
import { toast } from "sonner"
import { useAiDiffExplain } from "./use-ai-diff-explain"

let mockSettings: { gitSettings?: unknown }
let mockPii: boolean
let mockClient: { complete: jest.Mock } | null
let mockExplanation: string

const mockBuildClient = jest.fn((_arg?: unknown) => mockClient)
const mockRedactText = jest.fn((t: string) => ({ redacted: `RED(${t})`, map: {} }))
const mockGenerate = jest.fn((_input?: unknown) => Promise.resolve(mockExplanation))

jest.mock("@/lib/ai/generation/utility-client", () => ({
  buildUtilityLlmClient: (arg: unknown) => mockBuildClient(arg),
}))
jest.mock("@cognia/redact", () => ({
  hasNoLeakingPii: () => mockPii,
  redactText: (t: string) => mockRedactText(t),
}))
jest.mock("@/lib/git/ai-explain", () => ({
  generateDiffExplanation: (input: unknown) => mockGenerate(input),
}))
jest.mock("sonner", () => ({
  toast: { info: jest.fn(), warning: jest.fn(), error: jest.fn() },
}))
jest.mock("next-intl", () => ({ useTranslations: () => (k: string) => k }))
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: (sel: (s: unknown) => unknown) => sel({ settings: mockSettings }),
}))

const mockToast = toast as unknown as { info: jest.Mock; warning: jest.Mock; error: jest.Mock }

beforeEach(() => {
  jest.clearAllMocks()
  mockSettings = { gitSettings: { explainAI: { enabled: true } } }
  mockPii = true
  mockClient = { complete: jest.fn() }
  mockExplanation = "Renames foo to bar."
})

describe("useAiDiffExplain", () => {
  it("toasts and skips when the diff text is empty", async () => {
    const { result } = renderHook(() => useAiDiffExplain("a.ts", "   "))
    let out: string | null = "x"
    await act(async () => {
      out = await result.current.explain()
    })
    expect(out).toBeNull()
    expect(mockToast.info).toHaveBeenCalled()
    expect(mockGenerate).not.toHaveBeenCalled()
  })

  it("generates and stores the explanation", async () => {
    const { result } = renderHook(() => useAiDiffExplain("a.ts", "diff"))
    let out: string | null = null
    await act(async () => {
      out = await result.current.explain()
    })
    expect(out).toBe("Renames foo to bar.")
    expect(result.current.text).toBe("Renames foo to bar.")
    expect(mockBuildClient).toHaveBeenCalledWith(
      expect.objectContaining({ featureId: "git.explainDiff" })
    )
  })

  it("redacts the diff and warns on PII", async () => {
    mockPii = false
    const { result } = renderHook(() => useAiDiffExplain("a.ts", "secret"))
    await act(async () => {
      await result.current.explain()
    })
    expect(mockRedactText).toHaveBeenCalledWith("secret")
    expect(mockToast.warning).toHaveBeenCalled()
    const input = mockGenerate.mock.calls[0][0] as { diffText: string }
    expect(input.diffText).toBe("RED(secret)")
  })

  it("errors when the model returns an empty explanation", async () => {
    mockExplanation = ""
    const { result } = renderHook(() => useAiDiffExplain("a.ts", "diff"))
    let out: string | null = "x"
    await act(async () => {
      out = await result.current.explain()
    })
    expect(out).toBeNull()
    expect(mockToast.error).toHaveBeenCalled()
  })

  it("errors when no client resolves", async () => {
    mockClient = null
    const { result } = renderHook(() => useAiDiffExplain("a.ts", "diff"))
    let out: string | null = "x"
    await act(async () => {
      out = await result.current.explain()
    })
    expect(out).toBeNull()
    expect(mockToast.error).toHaveBeenCalled()
  })

  it("surfaces an error state when generation throws", async () => {
    mockGenerate.mockRejectedValueOnce(new Error("boom"))
    const { result } = renderHook(() => useAiDiffExplain("a.ts", "diff"))
    await act(async () => {
      await result.current.explain()
    })
    expect(result.current.error).toBe("boom")
    expect(mockToast.error).toHaveBeenCalled()
  })
})
