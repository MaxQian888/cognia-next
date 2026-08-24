import { act, renderHook } from "@testing-library/react"

import { useWorkspaceActionController } from "./use-workspace-action-controller"

describe("useWorkspaceActionController", () => {
  it("shares pending and success state across workspace action surfaces", async () => {
    let resolveOperation: ((value: string) => void) | undefined
    const operation = jest.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveOperation = resolve
        })
    )
    const { result } = renderHook(() => useWorkspaceActionController())

    let outcome!: Promise<string | undefined>
    act(() => {
      outcome = result.current.run("workspace-1", operation)
    })
    expect(result.current.pendingKey).toBe("workspace-1")
    expect(result.current.busy).toBe(true)

    await act(async () => {
      resolveOperation?.("done")
      await outcome
    })
    await expect(outcome).resolves.toBe("done")
    expect(result.current.pendingKey).toBeNull()
    expect(result.current.error).toBeNull()
  })

  it("normalizes failures and keeps them local to the controller", async () => {
    const { result } = renderHook(() => useWorkspaceActionController())

    await act(async () => {
      await expect(
        result.current.run("workspace-2", async () => {
          throw { detail: "registry protected" }
        })
      ).resolves.toBeUndefined()
    })
    expect(result.current.error).toBe("registry protected")

    act(() => result.current.clearError())
    expect(result.current.error).toBeNull()
  })
})
