/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

// Each chip is its own suite; here they are stubs that show what the group
// handed them, and two of them render nothing (as SLA / approvals do when idle).
jest.mock("./lifecycle-status-chip", () => ({
  LifecycleStatusChip: ({ status }: { status: string }) => <span>status:{status}</span>,
}))
jest.mock("./assignee-chip", () => ({
  AssigneeChip: ({ adapterId }: { adapterId?: string }) => (
    <span>assignee:{adapterId ?? "none"}</span>
  ),
}))
jest.mock("./label-picker", () => ({
  LabelPicker: ({ selectedIds }: { selectedIds: string[] }) => (
    <span>labels:{selectedIds.join(",")}</span>
  ),
}))
jest.mock("./sla-badge", () => ({ SlaBadge: () => null }))
jest.mock("./pending-approval-chip", () => ({ PendingApprovalChip: () => null }))
jest.mock("./last-inbound-chip", () => ({ LastInboundChip: () => <span>last-inbound</span> }))
jest.mock("./active-delegations-chip", () => ({ ActiveDelegationsChip: () => null }))
jest.mock("./provider-model-switcher", () => ({
  ProviderModelSwitcher: ({ modelOverride }: { modelOverride?: string }) => (
    <span>model:{modelOverride ?? ""}</span>
  ),
}))
jest.mock("./quiet-hours-chip", () => ({ QuietHoursChip: () => <span>quiet</span> }))
jest.mock("./at-strategy-chip", () => ({ AtStrategyChip: () => <span>at</span> }))
jest.mock("./topic-runtime-chip", () => ({ TopicRuntimeChip: () => <span>topic</span> }))
jest.mock("./policy-info", () => ({ PolicyInfo: () => <span>policy</span> }))
jest.mock("./adapter-health-badge", () => ({ AdapterHealthBadge: () => null }))
jest.mock("./outbound-status-pill", () => ({ OutboundStatusPill: () => <span>delivery</span> }))
jest.mock("./overrides/computer-use-toggle", () => ({
  ComputerUseToggle: ({ currentValue }: { currentValue: boolean }) => (
    <span>cu-toggle:{String(currentValue)}</span>
  ),
}))
jest.mock("./computer-use-chip", () => ({
  ComputerUseChip: ({ active }: { active: boolean }) => <span>cu-chip:{String(active)}</span>,
}))

import type { ConversationOverrideRow } from "@/lib/db/connector-types"
import {
  ControlItem,
  ControlList,
  ConversationComputerUseControl,
  ConversationHealthControls,
  ConversationRoutingControls,
  ConversationStatusControls,
} from "./conversation-control-groups"

const scope = { conversationKey: "lark:a1:oc", sessionId: "s1", adapterId: "a1" }
const row = {
  conversationKey: "lark:a1:oc",
  status: "pending",
  labelIds: ["l1", "l2"],
  allowComputerUse: true,
} as ConversationOverrideRow

describe("ControlItem", () => {
  it("is the bare control inline", () => {
    const { container } = render(
      <ControlItem label="Status" layout="inline">
        <span>x</span>
      </ControlItem>
    )
    expect(container.innerHTML).toBe("<span>x</span>")
  })

  it("is a labelled dt/dd row in a list that hides when the control renders nothing", () => {
    render(
      <ControlList aria-label="props">
        <ControlItem label="Status" layout="list" testId="row">
          <span>x</span>
        </ControlItem>
      </ControlList>
    )
    const item = screen.getByTestId("row")
    expect(item.querySelector("dt")).toHaveTextContent("Status")
    expect(item.querySelector("dd")).toHaveTextContent("x")
    expect(item).toHaveClass("has-[>dd:empty]:hidden")
    expect(screen.getByRole("term")).toBeInTheDocument()
  })
})

describe("ConversationStatusControls", () => {
  it("renders every status control from the live row, labelled in list layout", () => {
    render(
      <ControlList>
        <ConversationStatusControls layout="list" {...scope} overrideRow={row} />
      </ControlList>
    )
    expect(screen.getByTestId("control-status")).toHaveTextContent("Statusstatus:pending")
    expect(screen.getByTestId("control-assignee")).toHaveTextContent("assignee:a1")
    expect(screen.getByTestId("control-labels")).toHaveTextContent("labels:l1,l2")
    // Idle chips render nothing; their rows carry an empty dd and hide via CSS.
    expect(screen.getByTestId("control-sla").querySelector("dd")).toBeEmptyDOMElement()
    expect(screen.getByTestId("control-approvals").querySelector("dd")).toBeEmptyDOMElement()
  })

  it("defaults to open with no override row and no labels", () => {
    render(<ConversationStatusControls layout="inline" {...scope} adapterId="" />)
    expect(screen.getByText("status:open")).toBeInTheDocument()
    expect(screen.getByText("assignee:none")).toBeInTheDocument()
    expect(screen.getByText("labels:")).toBeInTheDocument()
  })
})

describe("ConversationRoutingControls", () => {
  it("shows the model switcher on desktop only", () => {
    const { rerender } = render(
      <ConversationRoutingControls
        layout="inline"
        {...scope}
        policy={undefined}
        modelOverride="m1"
        desktop
      />
    )
    expect(screen.getByText("model:m1")).toBeInTheDocument()
    rerender(
      <ConversationRoutingControls layout="inline" {...scope} policy={undefined} desktop={false} />
    )
    expect(screen.queryByText(/model:/)).not.toBeInTheDocument()
  })

  it("drops the adapter-scoped chips without an adapter id", () => {
    render(
      <ConversationRoutingControls
        layout="inline"
        {...scope}
        adapterId=""
        policy={undefined}
        desktop={false}
      />
    )
    expect(screen.queryByText("quiet")).not.toBeInTheDocument()
    expect(screen.getByText("policy")).toBeInTheDocument()
  })
})

describe("ConversationHealthControls", () => {
  it("renders nothing without an adapter", () => {
    const { container } = render(
      <ConversationHealthControls layout="inline" conversationKey="ck" adapterId="" />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it("renders health and delivery", () => {
    render(<ConversationHealthControls layout="inline" conversationKey="ck" adapterId="a1" />)
    expect(screen.getByText("delivery")).toBeInTheDocument()
  })
})

describe("ConversationComputerUseControl", () => {
  it("is the biometric toggle on desktop with an adapter", () => {
    render(<ConversationComputerUseControl layout="inline" {...scope} overrideRow={row} desktop />)
    expect(screen.getByText("cu-toggle:true")).toBeInTheDocument()
  })

  it("is nothing on desktop without an adapter", () => {
    const { container } = render(
      <ConversationComputerUseControl layout="inline" {...scope} adapterId="" desktop />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it("is the read-only chip elsewhere", () => {
    render(
      <ConversationComputerUseControl
        layout="inline"
        {...scope}
        overrideRow={row}
        desktop={false}
      />
    )
    expect(screen.getByText("cu-chip:true")).toBeInTheDocument()
  })
})
