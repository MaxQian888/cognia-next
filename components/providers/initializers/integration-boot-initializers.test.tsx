import { render } from "@testing-library/react"

jest.mock("./integration-runtime-initializer", () => ({
  IntegrationRuntimeInitializer: () => <span data-boot="integration" />,
}))
jest.mock("./models-dev-catalog-initializer", () => ({
  ModelsDevCatalogInitializer: () => <span data-boot="models-dev" />,
}))
jest.mock("./openrouter-catalog-initializer", () => ({
  OpenRouterCatalogInitializer: () => <span data-boot="openrouter" />,
}))
jest.mock("./provider-cost-mirror-initializer", () => ({
  ProviderCostMirrorInitializer: () => <span data-boot="provider-cost" />,
}))
jest.mock("@/components/connectors/connector-bus-provider", () => ({
  ConnectorBusProvider: () => <span data-boot="connectors" />,
}))
const mockMarkReady = jest.fn()
jest.mock("@/lib/boot/capabilities", () => ({
  markBootCapabilityReady: (...args: unknown[]) => mockMarkReady(...args),
}))

import { IntegrationBootInitializers } from "./integration-boot-initializers"

it("mounts integration runtimes and reports readiness", () => {
  const { container } = render(<IntegrationBootInitializers />)
  expect(
    Array.from(container.querySelectorAll("[data-boot]")).map((node) =>
      node.getAttribute("data-boot")
    )
  ).toEqual(["models-dev", "openrouter", "integration", "connectors", "provider-cost"])
  expect(mockMarkReady).toHaveBeenCalledWith("integrations")
})
