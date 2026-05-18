import {
  buildCapabilityPromptSection,
  evaluateSurfaceAgainstCapability,
} from "./capability-evaluator"
import { buildA2UICapabilityMatrix } from "@/types/connectors/capability"
import type { A2UISegmentContent } from "@/types/connectors/segment"

const richSurface: A2UISegmentContent = {
  components: {
    root: { id: "root", component: "Column", children: ["t", "btn", "chart"] },
    t: { id: "t", component: "Text", text: "x" },
    btn: { id: "btn", component: "Button", text: "Go", action: "go" },
    chart: { id: "chart", component: "Chart", chartType: "bar" },
  },
  dataModel: {},
  rootId: "root",
}

describe("evaluateSurfaceAgainstCapability", () => {
  it("buckets present kinds by support level", () => {
    const matrix = buildA2UICapabilityMatrix({
      Column: "native",
      Text: "native",
      Button: "fallback",
      Chart: "unsupported",
    })
    const ev = evaluateSurfaceAgainstCapability(richSurface, matrix)
    expect(ev.native.sort()).toEqual(["Column", "Text"])
    expect(ev.simulated).toEqual([])
    expect(ev.fallback).toEqual(["Button"])
    expect(ev.unsupported).toEqual(["Chart"])
    expect(ev.worstCase).toBe("unsupported")
  })

  it("buckets simulated kinds into their own bucket and orders worstCase 'unsupported > fallback > simulated > native'", () => {
    const matrix = buildA2UICapabilityMatrix({
      Column: "native",
      Text: "native",
      Button: "simulated",
      Chart: "fallback",
    })
    const ev = evaluateSurfaceAgainstCapability(richSurface, matrix)
    expect(ev.native.sort()).toEqual(["Column", "Text"])
    expect(ev.simulated).toEqual(["Button"])
    expect(ev.fallback).toEqual(["Chart"])
    expect(ev.unsupported).toEqual([])
    // fallback present → fallback beats simulated
    expect(ev.worstCase).toBe("fallback")
  })

  it("worstCase = 'simulated' when only native + simulated present", () => {
    const matrix = buildA2UICapabilityMatrix({
      Column: "native",
      Text: "native",
      Button: "simulated",
      Chart: "simulated",
    })
    const ev = evaluateSurfaceAgainstCapability(richSurface, matrix)
    expect(ev.simulated.sort()).toEqual(["Button", "Chart"])
    expect(ev.fallback).toEqual([])
    expect(ev.unsupported).toEqual([])
    expect(ev.worstCase).toBe("simulated")
  })

  it("worstCase = 'fallback' when only fallbacks present", () => {
    const matrix = buildA2UICapabilityMatrix({
      Column: "native",
      Text: "native",
      Button: "fallback",
      Chart: "fallback",
    })
    const ev = evaluateSurfaceAgainstCapability(richSurface, matrix)
    expect(ev.unsupported).toEqual([])
    expect(ev.worstCase).toBe("fallback")
  })

  it("worstCase = 'native' when every present kind is native", () => {
    const matrix = buildA2UICapabilityMatrix({
      Column: "native",
      Text: "native",
      Button: "native",
      Chart: "native",
    })
    const ev = evaluateSurfaceAgainstCapability(richSurface, matrix)
    expect(ev.worstCase).toBe("native")
    expect(ev.simulated).toEqual([])
    expect(ev.fallback).toEqual([])
    expect(ev.unsupported).toEqual([])
  })

  it("unknown component kinds are silently dropped (treated as fallback by renderer)", () => {
    const surface: A2UISegmentContent = {
      components: {
        root: { id: "root", component: "WeirdPlugin", payload: {} },
      },
      dataModel: {},
      rootId: "root",
    }
    const ev = evaluateSurfaceAgainstCapability(surface, buildA2UICapabilityMatrix({}))
    // No known kinds → all buckets empty, worstCase stays native (we
    // can't say anything definitive about an unknown kind).
    expect(ev.native).toEqual([])
    expect(ev.simulated).toEqual([])
    expect(ev.fallback).toEqual([])
    expect(ev.unsupported).toEqual([])
    expect(ev.worstCase).toBe("native")
  })
})

describe("buildCapabilityPromptSection", () => {
  it("includes native + fallback + unsupported sections", () => {
    const matrix = buildA2UICapabilityMatrix({
      Text: "native",
      Button: "native",
      Card: "fallback",
      Chart: "unsupported",
      Table: "unsupported",
    })
    const prompt = buildCapabilityPromptSection("Telegram", matrix)
    expect(prompt).toContain("Telegram")
    // Catalogue order: Text precedes Button (display family before forms).
    expect(prompt).toContain("Renders natively: Text, Button")
    expect(prompt).toContain("NOT supported")
    // Catalogue order: Table precedes Chart in the data family.
    expect(prompt).toContain("Table, Chart")
    expect(prompt).toContain("Degrades to plain text")
  })

  it("omits the unsupported bullet when nothing is unsupported", () => {
    const matrix = buildA2UICapabilityMatrix({
      Text: "native",
    })
    const prompt = buildCapabilityPromptSection("Slack", matrix)
    expect(prompt).toContain("Slack")
    expect(prompt).not.toContain("NOT supported")
  })

  it("includes the simulated bullet with multi-step UX warning when present", () => {
    const matrix = buildA2UICapabilityMatrix({
      Text: "native",
      TextField: "simulated",
      TextArea: "simulated",
    })
    const prompt = buildCapabilityPromptSection("Telegram", matrix)
    expect(prompt).toContain("Available via multi-step UX")
    expect(prompt).toContain("do not assume a synchronous reply")
    // Catalogue order: TextField precedes TextArea in the forms family.
    expect(prompt).toContain("TextField, TextArea")
  })

  it("omits the simulated bullet when no simulated kinds are present", () => {
    const matrix = buildA2UICapabilityMatrix({
      Text: "native",
      Button: "native",
    })
    const prompt = buildCapabilityPromptSection("Slack", matrix)
    expect(prompt).not.toContain("Available via multi-step UX")
  })
})
