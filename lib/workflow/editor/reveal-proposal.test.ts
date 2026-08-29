/**
 * @jest-environment jsdom
 */
import {
  PROPOSAL_ANCHOR_ATTR,
  proposalAnchorSelector,
  revealProposalInChat,
} from "./reveal-proposal"

function mount(html: string): HTMLElement {
  const root = document.createElement("div")
  root.innerHTML = html
  document.body.appendChild(root)
  return root
}

afterEach(() => {
  document.body.innerHTML = ""
})

describe("proposalAnchorSelector", () => {
  it("matches the attribute the proposal card renders", () => {
    expect(proposalAnchorSelector("p1")).toBe(`[${PROPOSAL_ANCHOR_ATTR}="p1"]`)
  })

  it("escapes ids that are not selector-safe", () => {
    // Proposal ids are generated, but the escape is what keeps a stray quote
    // from turning the lookup into a syntax error rather than a miss.
    const selector = proposalAnchorSelector('p"1')
    expect(() => document.querySelector(selector)).not.toThrow()
  })
})

describe("revealProposalInChat", () => {
  it("scrolls the proposal card into view", () => {
    const root = mount(`<div ${PROPOSAL_ANCHOR_ATTR}="p1"></div>`)
    const card = root.firstElementChild as HTMLElement
    const scrollIntoView = jest.fn()
    card.scrollIntoView = scrollIntoView

    expect(revealProposalInChat({ proposalId: "p1", root })).toBe(card)
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center", behavior: "smooth" })
  })

  it("falls back to the message row when the card is not rendered", () => {
    // Under virtualization the card can be unmounted while its message row is
    // still addressable, which is why the changelog hands over both ids.
    const root = mount(`<div data-msg-id="m1"></div>`)
    const row = root.firstElementChild as HTMLElement
    row.scrollIntoView = jest.fn()

    expect(revealProposalInChat({ proposalId: "p1", messageId: "m1", root })).toBe(row)
  })

  it("prefers the card over the message row when both are present", () => {
    const root = mount(`<div data-msg-id="m1"></div><div ${PROPOSAL_ANCHOR_ATTR}="p1"></div>`)
    const card = root.querySelector(`[${PROPOSAL_ANCHOR_ATTR}="p1"]`) as HTMLElement
    card.scrollIntoView = jest.fn()
    expect(revealProposalInChat({ proposalId: "p1", messageId: "m1", root })).toBe(card)
  })

  it("returns null when neither anchor is rendered, so callers can say so", () => {
    const root = mount("<div></div>")
    expect(revealProposalInChat({ proposalId: "p1", messageId: "m1", root })).toBeNull()
  })

  it("survives an element without scrollIntoView (jsdom / embedded WebViews)", () => {
    const root = mount(`<div ${PROPOSAL_ANCHOR_ATTR}="p1"></div>`)
    const card = root.firstElementChild as HTMLElement
    // @ts-expect-error deliberately removing the optional DOM method
    card.scrollIntoView = undefined
    expect(() => revealProposalInChat({ proposalId: "p1", root })).not.toThrow()
  })
})
