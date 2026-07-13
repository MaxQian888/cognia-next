import { render, act } from "@testing-library/react"

import { DeferredBootInitializers } from "./deferred-boot-initializers"

// Replace every `next/dynamic(...)` call with the same lightweight stub so we
// can assert how many deferred children get rendered without pulling the real
// workflow/gateway/connector/scheduler/agent-team subsystem graphs into the
// test.
jest.mock("next/dynamic", () => () => {
  const Stub = () => <span data-testid="deferred-child" />
  Stub.displayName = "MockDeferredChild"
  return Stub
})

let mockPetRole: "main" | "web" | "overlay" | "popup" = "main"
jest.mock("@/lib/pet/window-role", () => ({
  getPetWindowRole: () => mockPetRole,
  isSecondaryOverlayRole: (role: string) =>
    role === "overlay" || role === "popup" || role === "island",
}))

describe("DeferredBootInitializers", () => {
  beforeEach(() => {
    mockPetRole = "main"
  })

  it("renders every deferred child once mounted (all shells, no platform gate)", async () => {
    let container!: HTMLElement
    await act(async () => {
      container = render(<DeferredBootInitializers />).container
    })
    // Mirrors the count of bundled children in the component — a guard
    // against silently dropping one when the list changes.
    expect(container.querySelectorAll('[data-testid="deferred-child"]')).toHaveLength(6)
  })

  it.each(["overlay", "popup"] as const)("renders nothing in the %s pet window", async (role) => {
    mockPetRole = role
    let container!: HTMLElement
    await act(async () => {
      container = render(<DeferredBootInitializers />).container
    })
    // The bundled initializers are all main-window concerns; the pet
    // windows must not boot the workflow/gateway/connector runtimes.
    expect(container.querySelectorAll('[data-testid="deferred-child"]')).toHaveLength(0)
  })
})
