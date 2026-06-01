import { DEFAULT_CONFIG } from "../types"
import {
  appendReportNote,
  initState,
  recordStep,
  renderEvidence,
  renderWorkspace,
} from "./workspace"

describe("initState", () => {
  it("seeds the gap queue with the original question", () => {
    const s = initState("why is the sky blue?", DEFAULT_CONFIG)
    expect(s.gapQueue).toEqual(["why is the sky blue?"])
    expect(s.allowAnswer).toBe(true)
    expect(s.knowledge).toEqual([])
  })
})

describe("appendReportNote", () => {
  it("accumulates compact bullet notes", () => {
    const s = initState("q", DEFAULT_CONFIG)
    appendReportNote(s, "first  fact")
    appendReportNote(s, "second fact")
    expect(s.evolvingReport).toBe("- first fact\n- second fact")
  })
  it("ignores empty notes", () => {
    const s = initState("q", DEFAULT_CONFIG)
    appendReportNote(s, "   ")
    expect(s.evolvingReport).toBe("")
  })
  it("keeps the report bounded by trimming the oldest", () => {
    const s = initState("q", DEFAULT_CONFIG)
    for (let i = 0; i < 200; i++) appendReportNote(s, `fact number ${i} `.repeat(5))
    expect(s.evolvingReport.length).toBeLessThanOrEqual(4_000)
    expect(s.evolvingReport).toContain("199")
  })
})

describe("renderWorkspace", () => {
  it("includes question, memory, gaps, unread sources and progress", () => {
    const s = initState("the question", { ...DEFAULT_CONFIG, maxSteps: 10 })
    s.evolvingReport = "- known thing"
    s.candidates.push({ title: "Src A", url: "https://a.com", content: "x", score: 1 })
    s.step = 3
    const out = renderWorkspace(s)
    expect(out).toContain("QUESTION: the question")
    expect(out).toContain("known thing")
    expect(out).toContain("OPEN QUESTIONS")
    expect(out).toContain("Src A")
    expect(out).toContain("step 3/10")
  })
})

describe("renderEvidence", () => {
  it("numbers sources for citation", () => {
    const s = initState("q", DEFAULT_CONFIG)
    s.knowledge.push({ url: "https://a.com", title: "A", content: "alpha" })
    s.knowledge.push({ url: "https://b.com", title: "B", content: "beta" })
    const out = renderEvidence(s)
    expect(out).toContain("[1] A (https://a.com)")
    expect(out).toContain("[2] B (https://b.com)")
  })
  it("notes when no evidence is gathered", () => {
    expect(renderEvidence(initState("q", DEFAULT_CONFIG))).toContain("no sources")
  })
})

describe("recordStep", () => {
  it("appends a step entry", () => {
    const s = initState("q", DEFAULT_CONFIG)
    s.step = 2
    recordStep(s, "search", "did a search")
    expect(s.steps).toEqual([{ step: 2, action: "search", detail: "did a search" }])
  })
})
