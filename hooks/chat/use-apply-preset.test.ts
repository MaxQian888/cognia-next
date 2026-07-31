/**
 * @jest-environment jsdom
 */

import type { ChatSession, SystemPromptPreset } from "@cognia/agent-config-types"

const updateSessionMock = jest.fn(async (_id: string, _patch: Record<string, unknown>) => {})
const recordUsageMock = jest.fn(async (_id: string) => {})
const toastSuccess = jest.fn()
const toastError = jest.fn()

jest.mock("@/lib/data-hooks/context", () => ({
  useUpdateSession: () => updateSessionMock,
  useRecordPresetUsage: () => recordUsageMock,
}))
jest.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}))
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}))

import { act, renderHook } from "@testing-library/react"
import { useApplyPreset } from "./use-apply-preset"
import { useChatStore } from "@/stores/chat/chat-store"
import { useAgentRuntimeStore } from "@/stores/agent/agent-runtime-store"

const mkPreset = (over: Partial<SystemPromptPreset> = {}): SystemPromptPreset =>
  ({
    id: "p1",
    name: "Coding",
    content: "be a coder",
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }) as SystemPromptPreset

const mkSession = (over: Partial<ChatSession> = {}): ChatSession =>
  ({ id: "s1", kind: "direct", ...over }) as ChatSession

beforeEach(() => {
  updateSessionMock.mockClear()
  recordUsageMock.mockClear()
  toastSuccess.mockClear()
  toastError.mockClear()
  useChatStore.getState().setEphemeralSkillIds([])
  useChatStore.getState().setPermissionMode(null)
  useAgentRuntimeStore.setState({ modeId: "default" })
})

describe("useApplyPreset", () => {
  it("patches session-row fields + activePresetId and records usage", async () => {
    const { result } = renderHook(() => useApplyPreset())
    let ok = false
    await act(async () => {
      ok = await result.current(mkPreset({ model: "opus" }), mkSession())
    })
    expect(ok).toBe(true)
    expect(updateSessionMock).toHaveBeenCalledWith("s1", {
      systemPrompt: "be a coder",
      model: "opus",
      activePresetId: "p1",
    })
    expect(recordUsageMock).toHaveBeenCalledWith("p1")
    expect(toastSuccess).toHaveBeenCalled()
  })

  it("routes permissionMode to the chat store (not the row patch)", async () => {
    const { result } = renderHook(() => useApplyPreset())
    await act(async () => {
      await result.current(mkPreset({ permissionMode: "plan" }), mkSession())
    })
    expect(useChatStore.getState().permissionMode).toBe("plan")
    const patch = updateSessionMock.mock.calls[0][1]
    expect(patch).not.toHaveProperty("permissionMode")
  })

  it("unions preset skills into the ephemeral set and sets the agent mode", async () => {
    useChatStore.getState().setEphemeralSkillIds(["existing"])
    const { result } = renderHook(() => useApplyPreset())
    await act(async () => {
      await result.current(
        mkPreset({ skillIds: ["s_a", "existing"], agentModeId: "research" }),
        mkSession()
      )
    })
    expect(useChatStore.getState().ephemeralSkillIds.sort()).toEqual(["existing", "s_a"])
    expect(useAgentRuntimeStore.getState().modeId).toBe("research")
  })

  it("guards a null session: toasts an error and applies nothing", async () => {
    const { result } = renderHook(() => useApplyPreset())
    let ok = true
    await act(async () => {
      ok = await result.current(mkPreset(), null)
    })
    expect(ok).toBe(false)
    expect(toastError).toHaveBeenCalled()
    expect(updateSessionMock).not.toHaveBeenCalled()
  })
})
