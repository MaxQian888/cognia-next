import { render, screen } from "@testing-library/react"
import { SandboxDeliveryHistory } from "./sandbox-delivery-history"
import { useSandboxPlacement } from "@/hooks/sandbox/use-sandbox-placement"

jest.mock("@/hooks/sandbox/use-sandbox-placement", () => ({ useSandboxPlacement: jest.fn() }))
const usePlacement = jest.mocked(useSandboxPlacement)

it("renders distinct persisted sessions including saved work and cleanup retry state", () => {
  const record = {
    id: "first",
    agentId: "a",
    providerId: "e2b",
    instanceId: "instance",
    branch: "task/a",
    commit: "abc123",
    publishState: "savedBundle" as const,
    cleanupState: "destroyRetrying" as const,
    publish: { recovery: { bundle: "/host/recovery.bundle" } },
    createdAt: 100,
    updatedAt: 200,
    revision: 1,
  }
  usePlacement.mockReturnValue({
    requested: undefined,
    report: undefined,
    deliveryStatus: "ready",
    deliveries: [
      record,
      {
        ...record,
        id: "second",
        publishState: "discarded",
        cleanupState: "destroyed",
        publish: {},
      },
    ],
  })
  render(<SandboxDeliveryHistory agentId="a" />)
  expect(
    screen.getByRole("region", { name: "Remote sandbox delivery history" })
  ).toBeInTheDocument()
  expect(screen.getAllByRole("listitem")).toHaveLength(2)
  expect(screen.getByText("Saved bundle on Host: /host/recovery.bundle")).toBeInTheDocument()
  expect(screen.getByText("Instance destruction retrying")).toBeInTheDocument()
  expect(screen.getByText("Discarded at deadline")).toBeInTheDocument()
})

it("stays absent for a Host without records and reports a failed read without claiming an outcome", () => {
  usePlacement.mockReturnValue({
    requested: undefined,
    report: undefined,
    deliveries: [],
    deliveryStatus: "unavailable",
  })
  const { container, rerender } = render(<SandboxDeliveryHistory agentId="a" />)
  expect(container).toBeEmptyDOMElement()
  usePlacement.mockReturnValue({
    requested: undefined,
    report: undefined,
    deliveries: [],
    deliveryStatus: "failed",
  })
  rerender(<SandboxDeliveryHistory agentId="a" />)
  expect(screen.getByRole("status")).toHaveTextContent("Delivery history could not be loaded")
})

it("labels a durability failure even when there is no saved history yet", () => {
  usePlacement.mockReturnValue({
    requested: undefined,
    report: {
      agentId: "a",
      kind: "sandbox",
      deliveryRecordError: { code: "sandbox_delivery_store_failed" },
    },
    deliveries: [],
    deliveryStatus: "ready",
  })
  render(<SandboxDeliveryHistory agentId="a" />)
  expect(screen.getByRole("status")).toHaveTextContent(
    "The Host could not save this delivery update"
  )
})
