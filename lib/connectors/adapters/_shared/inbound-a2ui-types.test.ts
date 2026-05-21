/**
 * @jest-environment node
 *
 * Unit tests for the runtime helper exported from inbound-a2ui-types. The
 * rest of the module is type-only; `flatten` is the single runtime surface
 * mappers chain children through, so the contract is:
 *   - drop nullish entries
 *   - splice arrays in-place (no arrays-of-arrays in the output)
 *   - preserve declaration order
 */

import { flatten, type InboundA2UINode } from "./inbound-a2ui-types"

const text = (s: string): InboundA2UINode => ({ kind: "text", text: s })

describe("flatten", () => {
  it("returns an empty array when given an empty input", () => {
    expect(flatten([])).toEqual([])
  })

  it("passes single nodes through unchanged", () => {
    const node = text("hello")
    expect(flatten([node])).toEqual([node])
  })

  it("drops null and undefined entries", () => {
    expect(flatten([null, text("a"), undefined, text("b")])).toEqual([text("a"), text("b")])
  })

  it("inlines nested arrays of nodes (no arrays-of-arrays in output)", () => {
    const out = flatten([text("a"), [text("b"), text("c")], text("d")])
    expect(out).toEqual([text("a"), text("b"), text("c"), text("d")])
    expect(out.every((n) => !Array.isArray(n))).toBe(true)
  })

  it("preserves declaration order across mixed inputs", () => {
    const out = flatten([text("1"), null, [text("2"), text("3")], undefined, text("4")])
    expect(out.map((n) => (n.kind === "text" ? n.text : ""))).toEqual(["1", "2", "3", "4"])
  })

  it("emits nothing for an empty inner array but keeps its siblings", () => {
    const out = flatten([text("a"), [], text("b")])
    expect(out).toEqual([text("a"), text("b")])
  })

  it("does not mutate the input arrays", () => {
    const inner = [text("a"), text("b")]
    const input = [text("start"), inner, text("end")]
    const snapshotInner = [...inner]
    const snapshotInput = [...input]
    flatten(input)
    expect(inner).toEqual(snapshotInner)
    expect(input).toEqual(snapshotInput)
  })
})
