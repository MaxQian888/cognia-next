import { render } from "@testing-library/react"

// Stub the seven children so the test asserts composition + ORDER without
// booting the real workflow/gateway/connector/scheduler/agent-team runtimes.
jest.mock("./agent-team-runtime-initializer", () => ({
  AgentTeamRuntimeInitializer: () => <span data-boot="agent-team" />,
}))
jest.mock("./code-adoption-tracker-initializer", () => ({
  CodeAdoptionTrackerInitializer: () => <span data-boot="task-workspace-tracker" />,
}))
jest.mock("./memory-job-worker-initializer", () => ({
  MemoryJobWorkerInitializer: () => <span data-boot="memory-job-worker" />,
}))
jest.mock("@/components/scheduler/scheduler-initializer", () => ({
  SchedulerInitializer: () => <span data-boot="scheduler" />,
}))
jest.mock("@/components/providers/workflow-runtime-provider", () => ({
  WorkflowRuntimeProvider: () => <span data-boot="workflow" />,
}))
jest.mock("./provider-core-runtime-initializer", () => ({
  ProviderCoreRuntimeInitializer: () => <span data-boot="provider-core" />,
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
  it("renders all boot initializers in the layout's original document order", () => {
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
    expect(order).toEqual([
      "agent-team",
      "task-workspace-tracker",
      "memory-job-worker",
      "scheduler",
      "workflow",
      "provider-core",
      "routing",
      "gateway",
      "connector-bus",
    ])
  })
})
