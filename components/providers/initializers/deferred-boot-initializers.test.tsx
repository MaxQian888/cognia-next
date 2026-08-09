import { render, act } from "@testing-library/react"

import { DeferredBootInitializers } from "./deferred-boot-initializers"

// Replace the `next/dynamic(...)` boundary with a lightweight stub so we can
// assert the gating without pulling the impl chunk's subsystem graphs into
// the test. The impl's own composition is covered by
// deferred-boot-initializers-impl.test.tsx.
jest.mock("next/dynamic", () => () => {
  const state = globalThis as typeof globalThis & { __bootDynamicIndex?: number }
  const labels = ["core", "workflow", "integrations", "knowledge"]
  const index = state.__bootDynamicIndex ?? 0
  state.__bootDynamicIndex = index + 1
  const label = labels[index]
  const Stub = () => <span data-boot-bundle={label} />
  Stub.displayName = "MockDeferredBundle"
  return Stub
})

let mockRequested = new Set<string>(["core-chat"])
jest.mock("@/lib/boot/capabilities", () => ({
  getBootCapabilitySnapshot: () => mockRequested.size,
  subscribeBootCapabilities: () => () => {},
  isBootCapabilityRequested: (capability: string) => mockRequested.has(capability),
  markBootCapabilityFailed: jest.fn(),
}))

let mockPetRole: "main" | "web" | "overlay" | "popup" = "main"
jest.mock("@/lib/pet/window-role", () => ({
  getPetWindowRole: () => mockPetRole,
  isSecondaryOverlayRole: (role: string) =>
    role === "overlay" || role === "popup" || role === "island",
}))

describe("DeferredBootInitializers", () => {
  beforeEach(() => {
    mockPetRole = "main"
    mockRequested = new Set(["core-chat"])
  })

  it("mounts only the core bundle for a main-profile request", async () => {
    let container!: HTMLElement
    await act(async () => {
      container = render(<DeferredBootInitializers />).container
    })
    expect(
      Array.from(container.querySelectorAll("[data-boot-bundle]")).map((node) =>
        node.getAttribute("data-boot-bundle")
      )
    ).toEqual(["core"])
  })

  it("mounts every requested capability bundle in eager mode", async () => {
    mockRequested = new Set([
      "core-chat",
      "workflow-automation",
      "integrations",
      "knowledge-agents",
    ])
    let container!: HTMLElement
    await act(async () => {
      container = render(<DeferredBootInitializers />).container
    })
    expect(
      Array.from(container.querySelectorAll("[data-boot-bundle]")).map((node) =>
        node.getAttribute("data-boot-bundle")
      )
    ).toEqual(["core", "workflow", "integrations", "knowledge"])
  })

  it.each(["overlay", "popup"] as const)("renders nothing in the %s pet window", async (role) => {
    mockPetRole = role
    let container!: HTMLElement
    await act(async () => {
      container = render(<DeferredBootInitializers />).container
    })
    // The bundled initializers are all main-window concerns; the pet
    // windows must not boot the workflow/gateway/connector runtimes.
    expect(container.querySelectorAll("[data-boot-bundle]")).toHaveLength(0)
  })
})
