jest.mock("@/hooks/pet/use-local-pet-actions", () => ({
  useLocalPetActions: jest.fn(() => ({ mode: "local" })),
}))
jest.mock("@/hooks/pet/use-remote-pet-actions", () => ({
  useRemotePetActions: jest.fn(() => ({ mode: "remote" })),
}))

import { render, screen } from "@testing-library/react"
import { useLocalPetActions } from "@/hooks/pet/use-local-pet-actions"
import { useRemotePetActions } from "@/hooks/pet/use-remote-pet-actions"
import type { UsePetResult } from "@/hooks/pet/use-pet"
import { PetConsoleActionsProvider, usePetConsoleActions } from "./pet-console-actions-provider"

function Probe() {
  return <span data-testid="mode">{usePetConsoleActions().mode}</span>
}

const pet = { profile: undefined, view: undefined } as unknown as UsePetResult

beforeEach(() => jest.clearAllMocks())

describe("PetConsoleActionsProvider", () => {
  it("drives the pet directly on the desktop", () => {
    render(
      <PetConsoleActionsProvider mode="local" pet={pet} activeCharacterId="c1">
        <Probe />
      </PetConsoleActionsProvider>
    )
    expect(screen.getByTestId("mode")).toHaveTextContent("local")
    expect(useLocalPetActions).toHaveBeenCalledWith({ pet, activeCharacterId: "c1" })
    expect(useRemotePetActions).not.toHaveBeenCalled()
  })

  // The remote tree never subscribes to the local chat or shop paths.
  it("sends every action to the desktop from a paired device", () => {
    render(
      <PetConsoleActionsProvider mode="remote" pet={pet} activeCharacterId={null}>
        <Probe />
      </PetConsoleActionsProvider>
    )
    expect(screen.getByTestId("mode")).toHaveTextContent("remote")
    expect(useRemotePetActions).toHaveBeenCalled()
    expect(useLocalPetActions).not.toHaveBeenCalled()
  })
})
