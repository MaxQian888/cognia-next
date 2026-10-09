/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

let mockHealth: unknown = null
let mockOutbound: { status: string } | undefined
jest.mock("@/hooks/connectors/use-adapter-health", () => ({
  useAdapterHealth: () => mockHealth,
}))
jest.mock("@/hooks/connectors/use-latest-outbound-job", () => ({
  useLatestOutboundJob: () => mockOutbound,
}))
jest.mock("../adapter-health-decision", () => ({
  decideBadge: (health: unknown) => (health ? { state: "degraded" } : null),
}))
jest.mock("../conversation-control-groups", () => ({
  ControlList: ({ children }: { children: React.ReactNode }) => <dl>{children}</dl>,
  ConversationRoutingControls: (props: {
    layout: string
    desktop: boolean
    providerOverride?: string
  }) => (
    <div
      data-testid="routing-group"
      data-layout={props.layout}
      data-desktop={String(props.desktop)}
      data-provider={props.providerOverride ?? ""}
    />
  ),
  ConversationHealthControls: (props: { layout: string }) => (
    <div data-testid="health-group" data-layout={props.layout} />
  ),
  ConversationComputerUseControl: (props: { layout: string }) => (
    <div data-testid="cu-control" data-layout={props.layout} />
  ),
}))

import type { TriageConversation } from "@/hooks/inbox/use-triage-conversation"
import type { ConversationOverrideRow } from "@/lib/db/connector-types"
import { TriageDetails } from "./triage-details"

function conversation(over: Partial<TriageConversation> = {}): TriageConversation {
  return {
    session: { id: "s1", title: "Acme" } as TriageConversation["session"],
    conversationKey: "lark:a1:oc",
    adapterId: "a1",
    platform: "lark",
    override: { providerOverride: "anthropic" } as ConversationOverrideRow,
    adapter: undefined,
    policy: undefined,
    unreadCount: 0,
    ...over,
  }
}

beforeEach(() => {
  mockHealth = null
  mockOutbound = undefined
})

function renderDetails(props: Partial<React.ComponentProps<typeof TriageDetails>> = {}) {
  const handlers = { onOpenSettings: jest.fn(), onOpenBindings: jest.fn() }
  render(<TriageDetails conversation={conversation()} desktop={false} {...handlers} {...props} />)
  return handlers
}

describe("TriageDetails", () => {
  it("starts collapsed and expands to the shared routing, health and tool groups", async () => {
    renderDetails()
    const toggle = screen.getByRole("button", { name: /Routing & health/ })
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByTestId("routing-group")).toHaveAttribute("data-layout", "list")
    // The live override row is what feeds the model switcher.
    expect(screen.getByTestId("routing-group")).toHaveAttribute("data-provider", "anthropic")
    expect(screen.getByTestId("health-group")).toHaveAttribute("data-layout", "list")
    expect(screen.getByTestId("cu-control")).toHaveAttribute("data-layout", "list")
  })

  it("flags health trouble while collapsed", () => {
    mockHealth = { state: "down" }
    renderDetails()
    expect(screen.getByTestId("triage-details-attention")).toHaveAccessibleName("Needs attention")
  })

  it("flags a reply that did not go out", () => {
    mockOutbound = { status: "failed" }
    renderDetails()
    expect(screen.getByTestId("triage-details-attention")).toBeInTheDocument()
  })

  it("stays quiet when healthy", () => {
    mockOutbound = { status: "sent" }
    renderDetails()
    expect(screen.queryByTestId("triage-details-attention")).not.toBeInTheDocument()
  })

  it("opens settings, and the bindings inspector only on desktop", async () => {
    const web = renderDetails()
    await userEvent.click(screen.getByRole("button", { name: /Routing & health/ }))
    await userEvent.click(screen.getByRole("button", { name: "Conversation settings" }))
    expect(web.onOpenSettings).toHaveBeenCalled()
    expect(screen.queryByRole("button", { name: "Callback bindings" })).not.toBeInTheDocument()
  })

  it("offers the bindings inspector on desktop", async () => {
    const desktop = renderDetails({ desktop: true })
    await userEvent.click(screen.getByRole("button", { name: /Routing & health/ }))
    await userEvent.click(screen.getByRole("button", { name: "Callback bindings" }))
    expect(desktop.onOpenBindings).toHaveBeenCalled()
    expect(screen.getByTestId("routing-group")).toHaveAttribute("data-desktop", "true")
  })
})
