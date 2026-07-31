/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"

const buildClientMock = jest.fn()
const generateMock = jest.fn()
const toastError = jest.fn()
const toastWarning = jest.fn()

jest.mock("@/lib/ai/generation/utility-client", () => ({
  buildUtilityLlmClient: (...a: unknown[]) => buildClientMock(...a),
}))
jest.mock("@/lib/skills/generate-from-trace", () => ({
  generateSkillFromTrace: (...a: unknown[]) => generateMock(...a),
}))
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) => selector({ settings: {} }),
}))
jest.mock("sonner", () => ({
  toast: {
    error: (...a: unknown[]) => toastError(...a),
    warning: (...a: unknown[]) => toastWarning(...a),
  },
}))
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { useSkillGeneration } from "./use-skill-generation"

const TRACE = {
  sessionId: "s",
  startedAt: 0,
  endedAt: 1,
  observations: [{ seq: 1, tsMs: 0, kind: "click" }],
  monitors: [],
}

beforeEach(() => {
  buildClientMock.mockReset()
  generateMock.mockReset()
  toastError.mockClear()
  toastWarning.mockClear()
})

describe("useSkillGeneration", () => {
  it("returns null + errors when no client resolves", async () => {
    buildClientMock.mockReturnValue(null)
    const { result } = renderHook(() => useSkillGeneration())
    let draft: unknown
    await act(async () => {
      draft = await result.current.generate(TRACE as never)
    })
    expect(draft).toBeNull()
    expect(toastError).toHaveBeenCalledWith("recorder.generateFailed")
    expect(generateMock).not.toHaveBeenCalled()
  })

  it("returns the draft on success without a redaction toast", async () => {
    buildClientMock.mockReturnValue({ complete: jest.fn() })
    generateMock.mockResolvedValue({ draft: { name: "S", content: "x" }, redacted: false })
    const { result } = renderHook(() => useSkillGeneration())
    let draft: unknown
    await act(async () => {
      draft = await result.current.generate(TRACE as never)
    })
    expect(draft).toMatchObject({ name: "S" })
    expect(toastWarning).not.toHaveBeenCalled()
  })

  it("warns when the transcript was redacted", async () => {
    buildClientMock.mockReturnValue({ complete: jest.fn() })
    generateMock.mockResolvedValue({ draft: { name: "S", content: "x" }, redacted: true })
    const { result } = renderHook(() => useSkillGeneration())
    await act(async () => {
      await result.current.generate(TRACE as never)
    })
    expect(toastWarning).toHaveBeenCalledWith("recorder.redacted")
  })

  it("errors and returns null when generation throws", async () => {
    buildClientMock.mockReturnValue({ complete: jest.fn() })
    generateMock.mockRejectedValue(new Error("boom"))
    const { result } = renderHook(() => useSkillGeneration())
    let draft: unknown
    await act(async () => {
      draft = await result.current.generate(TRACE as never)
    })
    expect(draft).toBeNull()
    expect(toastError).toHaveBeenCalledWith("recorder.generateFailed")
  })
})
