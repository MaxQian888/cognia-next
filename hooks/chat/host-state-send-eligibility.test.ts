import { hostStateSendEligible, type HostStateSendFacts } from "./host-state-send-eligibility"

const plain: HostStateSendFacts = {
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
})
