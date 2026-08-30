import { evaluateProjectRecallGate } from "./recall-gate"

const BASE = {
  userMessage: "why does the build pin rust",
  projectId: "p1",
  enableProjectContinuity: true,
  temporary: false,
}

describe("evaluateProjectRecallGate", () => {
  it("allows an ordinary question in a workspace-bound chat", () => {
    expect(evaluateProjectRecallGate(BASE)).toEqual({ allowed: true })
  })

  it("skips when the user has not switched the section on", () => {
    expect(evaluateProjectRecallGate({ ...BASE, enableProjectContinuity: false })).toEqual({
      allowed: false,
      reason: "disabled",
    })
  })

  it("skips an incognito context", () => {
    expect(evaluateProjectRecallGate({ ...BASE, temporary: true }).allowed).toBe(false)
  })

  it("skips a chat with no workspace, since claims are scoped to one", () => {
    expect(evaluateProjectRecallGate({ ...BASE, projectId: undefined })).toEqual({
      allowed: false,
      reason: "no_workspace",
    })
  })

  it("skips machine-authored turns, which match scaffolding rather than a question", () => {
    expect(evaluateProjectRecallGate({ ...BASE, systemGenerated: true }).allowed).toBe(false)
  })

  it("skips a query with no meaningful term left after stopwords", () => {
    expect(evaluateProjectRecallGate({ ...BASE, userMessage: "  ??? the a of  " })).toEqual({
      allowed: false,
      reason: "no_query_terms",
    })
  })

  it("agrees with the retriever about what counts as a term", () => {
    // A gate with its own tokenizer would skip turns the retriever could have
    // answered — and the disagreement would be invisible.
    expect(evaluateProjectRecallGate({ ...BASE, userMessage: "pnpm" }).allowed).toBe(true)
    expect(evaluateProjectRecallGate({ ...BASE, userMessage: "构建为什么固定 rust" }).allowed).toBe(
      true
    )
  })

  it("never guesses whether a question is self-contained", () => {
    // Deliberately absent: that needs a classifier on the hottest path in the
    // app to save a BM25 scan. A conversational aside still passes the gate.
    expect(evaluateProjectRecallGate({ ...BASE, userMessage: "thanks, that worked" })).toEqual({
      allowed: true,
    })
  })
})
