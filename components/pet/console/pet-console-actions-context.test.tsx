import type { ReactNode } from "react"
import { renderHook } from "@testing-library/react"
import {
  PetConsoleActionsContext,
  useOptionalPetConsoleActions,
  usePetConsoleActions,
  type PetConsoleActions,
} from "./pet-console-actions-context"

const actions = { mode: "remote" } as PetConsoleActions
const wrapper = ({ children }: { children: ReactNode }) => (
  <PetConsoleActionsContext.Provider value={actions}>{children}</PetConsoleActionsContext.Provider>
)

describe("pet console actions context", () => {
  it("hands the provided actions to the console's tabs", () => {
    expect(renderHook(() => usePetConsoleActions(), { wrapper }).result.current).toBe(actions)
    expect(renderHook(() => useOptionalPetConsoleActions(), { wrapper }).result.current).toBe(
      actions
    )
  })

  it("is absent outside the console, for pieces the popup shares", () => {
    expect(renderHook(() => useOptionalPetConsoleActions()).result.current).toBeNull()
  })

  it("refuses to run a tab outside the provider rather than guess a mode", () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => undefined)
    try {
      expect(() => renderHook(() => usePetConsoleActions())).toThrow(/PetConsoleActionsProvider/)
    } finally {
      spy.mockRestore()
    }
  })
})
