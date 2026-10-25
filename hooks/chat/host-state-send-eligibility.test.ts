import { hostStateSendEligible, type HostStateSendFacts } from "./host-state-send-eligibility"

const plain: HostStateSendFacts = {
  pairedHost: false,
  personPartition: false,
  fusionRun: false,
  routerFusionStamped: false,
  skipAppend: false,
  contentIsString: true,
  hasResourceContext: false,
  attachmentCount: 0,
  builtinLane: true,
  addressed: false,
  carriesForeignTurns: false,
  collaboration: false,
  standalone: false,
}

describe("hostStateSendEligible", () => {
  it("hands a plain typed turn on the built-in lane to the Host", () => {
    expect(hostStateSendEligible(plain)).toBe(true)
  })

  it("never hands over a sealed Router + Fusion turn or a cascade/panel run (ADR-0188)", () => {
    expect(hostStateSendEligible({ ...plain, routerFusionStamped: true })).toBe(false)
    expect(hostStateSendEligible({ ...plain, fusionRun: true })).toBe(false)
  })

  it.each<[string, Partial<HostStateSendFacts>]>([
    ["a turn using the paired host transport", { pairedHost: true }],
    ["a re-issued turn", { skipAppend: true }],
    ["block content", { contentIsString: false }],
    ["a workbench resource", { hasResourceContext: true }],
    ["attachments", { attachmentCount: 1 }],
    ["another lane", { builtinLane: false }],
    ["an addressed turn", { addressed: true }],
    ["another runtime's replies", { carriesForeignTurns: true }],
    ["a shared conversation", { collaboration: true }],
    ["the standalone engine", { standalone: true }],
  ])("keeps %s on the direct path", (_label, change) => {
    expect(hostStateSendEligible({ ...plain, ...change })).toBe(false)
  })

  it("p6e hands a member's turn to their person partition, which takes only the intent", () => {
    const member = { ...plain, pairedHost: true, personPartition: true }
    expect(hostStateSendEligible(member)).toBe(true)
    // Everything else that keeps a turn on the direct path still does.
    expect(hostStateSendEligible({ ...member, attachmentCount: 1 })).toBe(false)
    expect(hostStateSendEligible({ ...member, routerFusionStamped: true })).toBe(false)
  })
})
