/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"

jest.mock("@/hooks/use-platform", () => ({ usePlatform: jest.fn(() => "tauri") }))
jest.mock("@/hooks/data/use-can-control", () => ({ useCanControl: jest.fn(() => true) }))
jest.mock("@/lib/tauri/transport-instance", () => ({ transport: { call: jest.fn() } }))
jest.mock("@/lib/goal/runtime", () => {
  const runtime = { createGoal: jest.fn() }
  return { getGoalRuntime: jest.fn(() => runtime) }
})
jest.mock("@/lib/goal/templates", () => ({
  createGoalFromTemplate: jest.fn(),
  resolveGoalTemplate: jest.fn(),
}))

import type { AppSettings } from "@cognia/agent-config-types"
import { useCanControl } from "@/hooks/data/use-can-control"
import { usePlatform } from "@/hooks/use-platform"
import { getGoalRuntime } from "@/lib/goal/runtime"
import { createGoalFromTemplate, resolveGoalTemplate } from "@/lib/goal/templates"
import { transport } from "@/lib/tauri/transport-instance"
import { useGoalCreate } from "./use-goal-create"

const usePlatformMock = usePlatform as jest.Mock
const useCanControlMock = useCanControl as jest.Mock
const callMock = transport.call as jest.Mock
const createGoalMock = (getGoalRuntime as jest.Mock)().createGoal as jest.Mock
const fromTemplateMock = createGoalFromTemplate as jest.Mock
const resolveTemplateMock = resolveGoalTemplate as jest.Mock

const SETTINGS = { defaultProvider: "anthropic" } as unknown as AppSettings

beforeEach(() => {
  usePlatformMock.mockReturnValue("tauri")
  useCanControlMock.mockReturnValue(true)
  callMock.mockReset().mockResolvedValue({ goal: { id: "g-remote" } })
  createGoalMock.mockReset().mockResolvedValue({ id: "g1" })
  fromTemplateMock.mockReset().mockResolvedValue({ id: "g2" })
  resolveTemplateMock.mockReset().mockResolvedValue({
    rawObjective: "review the PR",
    config: { maxTurns: 30 },
  })
})

describe("useGoalCreate — on this host", () => {
  it("is local and allowed", () => {
    const { result } = renderHook(() => useGoalCreate())
    expect(result.current.remote).toBe(false)
    expect(result.current.allowed).toBe(true)
  })

  it("creates a typed objective through the runtime with this host's settings", async () => {
    const { result } = renderHook(() => useGoalCreate())
    await act(() =>
      result.current.create({ sessionId: "s1", rawObjective: "ship it", appSettings: SETTINGS })
    )
    expect(createGoalMock).toHaveBeenCalledWith({
      sessionId: "s1",
      rawObjective: "ship it",
      appSettings: SETTINGS,
    })
    expect(callMock).not.toHaveBeenCalled()
  })

  it("creates from a template through createGoalFromTemplate", async () => {
    const { result } = renderHook(() => useGoalCreate())
    await act(() =>
      result.current.create({ sessionId: "s1", templateId: "tpl1", appSettings: null })
    )
    expect(fromTemplateMock).toHaveBeenCalledWith({
      templateId: "tpl1",
      sessionId: "s1",
      appSettings: null,
    })
    expect(createGoalMock).not.toHaveBeenCalled()
  })

  it("lets a runtime refusal reach the caller", async () => {
    createGoalMock.mockRejectedValueOnce(new Error("PII gate"))
    const { result } = renderHook(() => useGoalCreate())
    await expect(
      result.current.create({ sessionId: "s1", rawObjective: "x", appSettings: null })
    ).rejects.toThrow("PII gate")
  })
})

describe("useGoalCreate — on a paired phone", () => {
  beforeEach(() => usePlatformMock.mockReturnValue("mobile"))

  it("is remote, and allowed only with the remote-control grant", () => {
    useCanControlMock.mockReturnValue("unknown")
    const { result, rerender } = renderHook(() => useGoalCreate())
    expect(result.current.remote).toBe(true)
    expect(result.current.allowed).toBe(false)
    useCanControlMock.mockReturnValue(true)
    rerender()
    expect(result.current.allowed).toBe(true)
  })

  it("sends a typed objective over goal_create without this device's settings", async () => {
    const { result } = renderHook(() => useGoalCreate())
    await act(() =>
      result.current.create({ sessionId: "s1", rawObjective: "ship it", appSettings: SETTINGS })
    )
    expect(callMock).toHaveBeenCalledWith("goal_create", {
      sessionId: "s1",
      rawObjective: "ship it",
    })
    expect(createGoalMock).not.toHaveBeenCalled()
  })

  it("reads the template here and sends its objective and config", async () => {
    const { result } = renderHook(() => useGoalCreate())
    await act(() =>
      result.current.create({ sessionId: "s1", templateId: "tpl1", appSettings: null })
    )
    expect(resolveTemplateMock).toHaveBeenCalledWith("tpl1")
    expect(callMock).toHaveBeenCalledWith("goal_create", {
      sessionId: "s1",
      rawObjective: "review the PR",
      config: { maxTurns: 30 },
    })
    expect(fromTemplateMock).not.toHaveBeenCalled()
  })

  it("omits config for a template without overrides", async () => {
    resolveTemplateMock.mockResolvedValueOnce({ rawObjective: "plain" })
    const { result } = renderHook(() => useGoalCreate())
    await act(() =>
      result.current.create({ sessionId: "s1", templateId: "tpl2", appSettings: null })
    )
    expect(callMock).toHaveBeenCalledWith("goal_create", { sessionId: "s1", rawObjective: "plain" })
  })

  it("refuses without the grant instead of sending a call the desktop would reject", async () => {
    useCanControlMock.mockReturnValue(false)
    const { result } = renderHook(() => useGoalCreate())
    await expect(
      result.current.create({ sessionId: "s1", rawObjective: "x", appSettings: null })
    ).rejects.toThrow(/remote-control grant/)
    expect(callMock).not.toHaveBeenCalled()
  })

  it("lets an RPC failure reach the caller", async () => {
    callMock.mockRejectedValueOnce(new Error("offline"))
    const { result } = renderHook(() => useGoalCreate())
    await expect(
      result.current.create({ sessionId: "s1", rawObjective: "x", appSettings: null })
    ).rejects.toThrow("offline")
  })
})
