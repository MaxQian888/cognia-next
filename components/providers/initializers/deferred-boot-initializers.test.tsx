import { render, act } from "@testing-library/react"

import { DeferredBootInitializers } from "./deferred-boot-initializers"

// Replace the `next/dynamic(...)` boundary with a lightweight stub so we can
// assert the gating without pulling the impl chunk's subsystem graphs into
// the test. The impl's own composition is covered by
// deferred-boot-initializers-impl.test.tsx.
jest.mock("next/dynamic", () => () => {
  const Stub = () => <span data-testid="deferred-bundle" />
  Stub.displayName = "MockDeferredBundle"
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

  it("mounts the single deferred bundle once hydrated (all shells, no platform gate)", async () => {
    let container!: HTMLElement
    await act(async () => {
      container = render(<DeferredBootInitializers />).container
    })
    expect(container.querySelectorAll('[data-testid="deferred-bundle"]')).toHaveLength(1)
  })

  it.each(["overlay", "popup"] as const)("renders nothing in the %s pet window", async (role) => {
    mockPetRole = role
    let container!: HTMLElement
    await act(async () => {
      container = render(<DeferredBootInitializers />).container
    })
    // The bundled initializers are all main-window concerns; the pet
    // windows must not boot the workflow/gateway/connector runtimes.
    expect(container.querySelectorAll('[data-testid="deferred-bundle"]')).toHaveLength(0)
  })
})
