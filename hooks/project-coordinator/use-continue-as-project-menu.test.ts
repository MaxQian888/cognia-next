/** @jest-environment jsdom */
import { act, renderHook } from "@testing-library/react"
import type { ChatSession } from "@cognia/agent-config-types"

// next-intl is globally mocked against en.json in jest.setup.ts.

const push = jest.fn()
jest.mock("next/navigation", () => ({ useRouter: () => ({ push }) }))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))
jest.mock("@/lib/project-coordinator/continue-as-project", () => ({
  continueAsProject: jest.fn(),
}))

import { toast } from "sonner"
import { continueAsProject } from "@/lib/project-coordinator/continue-as-project"
import { useContinueAsProjectMenu } from "./use-continue-as-project-menu"

const run = continueAsProject as jest.Mock
const session = {
  id: "s1",
  kind: "direct",
  projectId: "p1",
  createdAt: 1,
  updatedAt: 1,
} as ChatSession

beforeEach(() => jest.clearAllMocks())

describe("useContinueAsProjectMenu", () => {
  it("is not offered for a conversation that cannot become a thread", () => {
    const { result } = renderHook(() =>
      useContinueAsProjectMenu({ ...session, projectRole: "coordinator" })
    )
    expect(result.current.onContinueAsProject).toBeUndefined()
  })

  it("continues, confirms and opens the coordinator", async () => {
    run.mockResolvedValue({ kind: "continued", coordinator: { id: "coord" }, seeded: true })
    const { result } = renderHook(() => useContinueAsProjectMenu(session))
    await act(async () => {
      result.current.onContinueAsProject!()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(run).toHaveBeenCalledWith({ sessionId: "s1", coordinatorTitle: "Project coordinator" })
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining("planning what remains"))
    expect(push).toHaveBeenCalledWith(expect.stringContaining("coord"))
  })

  it("says when the coordinator could not be seeded", async () => {
    run.mockResolvedValue({ kind: "continued", coordinator: { id: "coord" }, seeded: false })
    const { result } = renderHook(() => useContinueAsProjectMenu(session))
    await act(async () => {
      result.current.onContinueAsProject!()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining("Tell the coordinator"))
  })

  it("explains a refusal and reports a failure", async () => {
    run.mockResolvedValueOnce({ kind: "refused", reason: "busy" })
    const { result } = renderHook(() => useContinueAsProjectMenu(session))
    await act(async () => {
      result.current.onContinueAsProject!()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("current reply"))
    expect(push).not.toHaveBeenCalled()

    run.mockRejectedValueOnce(new Error("boom"))
    await act(async () => {
      result.current.onContinueAsProject!()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(toast.error).toHaveBeenLastCalledWith(expect.stringContaining("boom"))
  })
})
