import { render } from "@testing-library/react"

// Stub the seven children so the test asserts composition + ORDER without
// booting the real workflow/gateway/connector/scheduler/agent-team runtimes.
jest.mock("./provider-core-runtime-initializer", () => ({
  ProviderCoreRuntimeInitializer: () => <span data-boot="provider-core" />,
}))
jest.mock("./routing-runtime-initializer", () => ({
  RoutingRuntimeInitializer: () => <span data-boot="routing" />,
}))
jest.mock("@/components/providers/gateway-provider", () => ({
  GatewayProvider: () => <span data-boot="gateway" />,
}))
const recoverDirectRuns = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/execution/direct-chat-run", () => ({
  recoverStaleDirectChatExecutionRuns: () => recoverDirectRuns(),
}))
const mockMarkReady = jest.fn()
jest.mock("@/lib/boot/capabilities", () => ({
  markBootCapabilityReady: (...args: unknown[]) => mockMarkReady(...args),
}))

import { DeferredBootInitializersImpl } from "./deferred-boot-initializers-impl"

describe("DeferredBootInitializersImpl", () => {
  it("renders the load-bearing core provider order and reports readiness", () => {
    const { container } = render(<DeferredBootInitializersImpl />)
    const order = Array.from(container.querySelectorAll("[data-boot]")).map((el) =>
      el.getAttribute("data-boot")
    )
    // Two orderings are load-bearing: routing BEFORE gateway (the gateway's
    // decide path reads the adapters routing reconnects), and provider-core
    // BEFORE both (it installs the proxy-fetch adapter their network calls
    // read; without it they degrade to a bare `fetch` the packaged shell's CSP
    // blocks). The rest preserves the pre-deferral layout order so a dropped
    // child is caught here.
    expect(order).toEqual(["provider-core", "routing", "gateway"])
    expect(mockMarkReady).toHaveBeenCalledWith("core-chat")
    expect(recoverDirectRuns).toHaveBeenCalledTimes(1)
  })
})
