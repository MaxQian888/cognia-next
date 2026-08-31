import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}))

import { ServiceCard } from "./service-card"
import type { ServiceProviderView, ServiceView } from "@/lib/external-services/service-view"

function provider(overrides: Partial<ServiceProviderView> = {}): ServiceProviderView {
  return {
    providerId: "desktop",
    kind: "mcp",
    availability: "supported",
    surfaces: ["chat"],
    priority: 90,
    connection: null,
    state: "not-connected",
    action: { kind: "none" },
    ...overrides,
  }
}

function service(overrides: Partial<ServiceView> = {}): ServiceView {
  return {
    key: "figma-external-service:figma",
    pluginId: "figma-external-service",
    serviceId: "figma",
    label: "Figma",
    description: "Design context.",
    icon: "🎨",
    skillIds: ["figma-use"],
    providers: [provider()],
    connected: false,
    awaitingReview: false,
    ...overrides,
  }
}

function renderCard(view: ServiceView, onToggleProvider = jest.fn()) {
  render(<ServiceCard service={view} onToggleProvider={onToggleProvider} />)
  return { onToggleProvider }
}

describe("ServiceCard", () => {
  it("renders one card per service with its providers nested inside", () => {
    renderCard(
      service({
        providers: [
          provider({ providerId: "remote", action: { kind: "blocked-upstream" } }),
          provider({ providerId: "desktop" }),
        ],
      })
    )
    expect(screen.getByTestId("external-service-figma")).toBeInTheDocument()
    expect(screen.getByTestId("external-service-provider-figma-remote")).toBeInTheDocument()
    expect(screen.getByTestId("external-service-provider-figma-desktop")).toBeInTheDocument()
  })

  it("leads a pending managed server to its review in the MCP section", () => {
    // The dead end this fixes: the row said "pending" and offered only Pause.
    renderCard(
      service({
        awaitingReview: true,
        providers: [
          provider({
            state: "pending",
            action: { kind: "review", serverId: "srv-1" },
            connection: { enabledSurfaces: ["chat"] } as ServiceProviderView["connection"],
          }),
        ],
      })
    )
    // `asChild` collapses the Button into the anchor, so the testid IS the link.
    const link = screen.getByTestId("external-service-provider-figma-desktop-primary")
    expect(link).toHaveTextContent("services.action.review")
    expect(link).toHaveAttribute("href", "/settings?section=mcp&server=srv-1")
  })

  it("explains what pending is waiting for", () => {
    renderCard(
      service({
        providers: [provider({ state: "pending", action: { kind: "review", serverId: "s" } })],
      })
    )
    expect(screen.getByTestId("external-service-provider-figma-desktop")).toHaveTextContent(
      "services.reviewHint"
    )
  })

  it("disables the action and names the vendor when upstream is the blocker", () => {
    renderCard(
      service({
        providers: [provider({ providerId: "remote", action: { kind: "blocked-upstream" } })],
      })
    )
    const button = screen.getByTestId("external-service-provider-figma-remote-primary")
    expect(button).toBeDisabled()
    expect(button).toHaveTextContent("services.action.blockedUpstream")
  })

  it("renders no primary button when there is genuinely nothing to do", () => {
    renderCard(service({ providers: [provider({ action: { kind: "none" } })] }))
    expect(
      screen.queryByTestId("external-service-provider-figma-desktop-primary")
    ).not.toBeInTheDocument()
  })

  it("shows the toggle only for a provisioned connection", () => {
    renderCard(service({ providers: [provider()] }))
    expect(
      screen.queryByTestId("external-service-provider-figma-desktop-toggle")
    ).not.toBeInTheDocument()
  })

  it("hands the toggled provider back to the caller", async () => {
    const target = provider({
      state: "connected",
      action: { kind: "manage", serverId: "s" },
      connection: { enabledSurfaces: ["chat"] } as ServiceProviderView["connection"],
    })
    const { onToggleProvider } = renderCard(service({ providers: [target] }))
    await userEvent.click(screen.getByTestId("external-service-provider-figma-desktop-toggle"))
    expect(onToggleProvider).toHaveBeenCalledWith(target)
  })

  it("badges the service as connected when any provider is", () => {
    renderCard(service({ connected: true }))
    expect(screen.getByTestId("external-service-figma-connected")).toBeInTheDocument()
    expect(screen.queryByTestId("external-service-figma-review")).not.toBeInTheDocument()
  })

  it("badges a review as pending when nothing is connected yet", () => {
    renderCard(service({ awaitingReview: true }))
    expect(screen.getByTestId("external-service-figma-review")).toBeInTheDocument()
  })

  it("exposes state and action for styling and assertions", () => {
    renderCard(
      service({
        providers: [provider({ state: "suspended", action: { kind: "resume" } })],
      })
    )
    const row = screen.getByTestId("external-service-provider-figma-desktop")
    expect(row).toHaveAttribute("data-state", "suspended")
    expect(row).toHaveAttribute("data-action", "resume")
  })
})
