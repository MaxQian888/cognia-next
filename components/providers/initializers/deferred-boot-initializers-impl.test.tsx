import { render } from "@testing-library/react"

// Stub the six children so the test asserts composition + ORDER without
// booting the real workflow/gateway/connector/scheduler/agent-team runtimes.
jest.mock("./agent-team-runtime-initializer", () => ({
  AgentTeamRuntimeInitializer: () => <span data-boot="agent-team" />,
}))
jest.mock("@/components/scheduler/scheduler-initializer", () => ({
  SchedulerInitializer: () => <span data-boot="scheduler" />,
}))
jest.mock("@/components/providers/workflow-runtime-provider", () => ({
  WorkflowRuntimeProvider: () => <span data-boot="workflow" />,
}))
jest.mock("./routing-runtime-initializer", () => ({
  RoutingRuntimeInitializer: () => <span data-boot="routing" />,
}))
jest.mock("@/components/providers/gateway-provider", () => ({
  GatewayProvider: () => <span data-boot="gateway" />,
}))
jest.mock("@/components/connectors/connector-bus-provider", () => ({
  ConnectorBusProvider: () => <span data-boot="connector-bus" />,
}))

import { DeferredBootInitializersImpl } from "./deferred-boot-initializers-impl"

describe("DeferredBootInitializersImpl", () => {
  it("renders all six boot initializers in the layout's original document order", () => {
    const { container } = render(<DeferredBootInitializersImpl />)
    const order = Array.from(container.querySelectorAll("[data-boot]")).map((el) =>
      el.getAttribute("data-boot")
    )
    // Routing BEFORE gateway is load-bearing (the gateway's decide path reads
    // the adapters routing reconnects); the rest preserves the pre-deferral
    // layout order so a dropped child is caught here.
    expect(order).toEqual([
      "agent-team",
      "scheduler",
      "workflow",
      "routing",
      "gateway",
      "connector-bus",
    ])
  })
})
