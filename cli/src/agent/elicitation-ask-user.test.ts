/** @jest-environment node */
import type { AskUserAnswer, AskUserRequest } from "@/lib/claude/ask-user-tool"
import type { AcpElicitationRequest } from "@/types/agent/external-agent"

import {
  answerElicitationThroughAskUser,
  askUserAnswerToValue,
  elicitationPropertyToAskUser,
} from "./elicitation-ask-user"

/** A Pi dialog exactly as `piDialogSchema` shapes it: one property per method. */
function piRequest(
  method: string,
  property: Record<string, unknown>,
  message = "Pick a branch"
): AcpElicitationRequest {
  return {
    id: "dlg-1",
    mode: "form",
    message,
    requestedSchema: {
      type: "object",
      title: property.title as string,
      properties: { [method]: property as never },
      required: [method],
    },
    raw: { method },
  }
}

const answer = (over: Partial<AskUserAnswer> = {}): AskUserAnswer => ({
  selected: [],
  text: "",
  cancelled: false,
  ...over,
})

describe("elicitationPropertyToAskUser", () => {
  it("renders a confirm as a yes/no choice, never as free text", () => {
    const question = elicitationPropertyToAskUser(
      piRequest("confirm", { type: "boolean", title: "Delete it?" }),
      "confirm",
      { type: "boolean", title: "Delete it?" }
    )
    expect(question.options.map((o) => o.value)).toEqual(["true", "false"])
    expect(question.allowText).toBe(false)
    expect(question.multiSelect).toBe(false)
  })

  it("carries a select's choices through", () => {
    const schema = { type: "string" as const, title: "Branch", enum: ["main", "dev"] }
    const question = elicitationPropertyToAskUser(piRequest("select", schema), "select", schema)
    expect(question.options).toEqual([
      { value: "main", label: "main" },
      { value: "dev", label: "dev" },
    ])
    expect(question.allowText).toBe(false)
  })

  it("prefers oneOf titles over the raw constants", () => {
    const schema = {
      type: "string" as const,
      title: "Branch",
      oneOf: [{ const: "main", title: "Production" }, { const: "dev" }],
    }
    const question = elicitationPropertyToAskUser(piRequest("select", schema), "select", schema)
    expect(question.options).toEqual([
      { value: "main", label: "Production" },
      { value: "dev", label: "dev" },
    ])
  })

  /** With no fixed choices the only way to answer is to type one. */
  it("opens free text when a string offers no choices", () => {
    const schema = { type: "string" as const, title: "Name" }
    const question = elicitationPropertyToAskUser(piRequest("input", schema), "input", schema)
    expect(question.options).toEqual([])
    expect(question.allowText).toBe(true)
  })

  it("multi-selects an array of choices", () => {
    const schema = {
      type: "array" as const,
      title: "Files",
      items: { type: "string" as const, enum: ["a.ts", "b.ts"] },
    }
    const question = elicitationPropertyToAskUser(piRequest("select", schema), "files", schema)
    expect(question.multiSelect).toBe(true)
    expect(question.options.map((o) => o.value)).toEqual(["a.ts", "b.ts"])
  })

  it("does not ask the same sentence twice when title and message coincide", () => {
    const schema = { type: "string" as const, title: "Pick a branch" }
    const question = elicitationPropertyToAskUser(piRequest("input", schema), "input", schema)
    expect(question.question).toBe("Pick a branch")
  })

  it("appends a title that adds information", () => {
    const schema = { type: "string" as const, title: "Branch" }
    const question = elicitationPropertyToAskUser(piRequest("input", schema), "input", schema)
    expect(question.question).toBe("Pick a branch — Branch")
  })
})

describe("askUserAnswerToValue", () => {
  it("reads a boolean back as a boolean, including false", () => {
    const schema = { type: "boolean" as const }
    expect(askUserAnswerToValue(schema, answer({ selected: ["true"] }))).toBe(true)
    expect(askUserAnswerToValue(schema, answer({ selected: ["false"] }))).toBe(false)
    // Nothing picked is not the same as `false`.
    expect(askUserAnswerToValue(schema, answer())).toBeUndefined()
  })

  it("keeps every pick for an array property", () => {
    expect(askUserAnswerToValue({ type: "array" }, answer({ selected: ["a.ts", "b.ts"] }))).toEqual(
      ["a.ts", "b.ts"]
    )
  })

  it("takes free text when no option was chosen", () => {
    expect(askUserAnswerToValue({ type: "string" }, answer({ text: "  feature-x  " }))).toBe(
      "feature-x"
    )
  })

  /**
   * An `editor` left untouched keeps its prefill: that is what the user saw and
   * chose not to change, so sending nothing would silently discard it.
   */
  it("falls back to a prefilled default rather than sending nothing", () => {
    expect(askUserAnswerToValue({ type: "string", default: "fix: something" }, answer())).toBe(
      "fix: something"
    )
  })

  it("returns undefined when there is genuinely no answer", () => {
    expect(askUserAnswerToValue({ type: "string" }, answer())).toBeUndefined()
    expect(askUserAnswerToValue({ type: "string" }, answer({ text: "   " }))).toBeUndefined()
  })
})

describe("answerElicitationThroughAskUser", () => {
  it("collects a single-property Pi dialog into an accept", async () => {
    const asked: AskUserRequest[] = []
    const response = await answerElicitationThroughAskUser(
      piRequest("select", { type: "string", title: "Branch", enum: ["main", "dev"] }),
      async (question) => {
        asked.push(question)
        return answer({ selected: ["dev"] })
      }
    )

    expect(asked).toHaveLength(1)
    expect(response).toEqual({
      requestId: "dlg-1",
      action: "accept",
      content: { select: "dev" },
    })
  })

  it("asks each property of a multi-field schema in order", async () => {
    const request: AcpElicitationRequest = {
      id: "dlg-2",
      mode: "form",
      message: "Configure the deploy",
      requestedSchema: {
        type: "object",
        properties: {
          env: { type: "string", title: "Environment", enum: ["staging", "prod"] },
          notes: { type: "string", title: "Notes" },
        },
        required: ["env"],
      },
      raw: {},
    }

    const asked: string[] = []
    const response = await answerElicitationThroughAskUser(request, async (question) => {
      asked.push(question.question)
      return question.options.length > 0
        ? answer({ selected: ["staging"] })
        : answer({ text: "first deploy" })
    })

    expect(asked).toEqual(["Configure the deploy — Environment", "Configure the deploy — Notes"])
    expect(response).toEqual({
      requestId: "dlg-2",
      action: "accept",
      content: { env: "staging", notes: "first deploy" },
    })
  })

  /**
   * Half a multi-field answer is not an answer, so a cancel anywhere cancels
   * the whole request rather than submitting a partial object.
   */
  it("cancels the whole request when any question is dismissed", async () => {
    const request: AcpElicitationRequest = {
      id: "dlg-3",
      mode: "form",
      message: "Configure the deploy",
      requestedSchema: {
        type: "object",
        properties: {
          env: { type: "string", title: "Environment", enum: ["staging"] },
          notes: { type: "string", title: "Notes" },
        },
      },
      raw: {},
    }

    let calls = 0
    const response = await answerElicitationThroughAskUser(request, async () => {
      calls += 1
      return calls === 1 ? answer({ selected: ["staging"] }) : answer({ cancelled: true })
    })

    expect(response).toEqual({ requestId: "dlg-3", action: "cancel" })
    expect(response).not.toHaveProperty("content")
  })

  it("omits a property the user left blank instead of sending an empty string", async () => {
    const request: AcpElicitationRequest = {
      id: "dlg-4",
      mode: "form",
      message: "Optional note",
      requestedSchema: { type: "object", properties: { notes: { type: "string" } } },
      raw: {},
    }

    const response = await answerElicitationThroughAskUser(request, async () => answer())
    expect(response).toEqual({ requestId: "dlg-4", action: "accept", content: {} })
  })

  /** A url elicitation collects nothing — it asks whether the user finished. */
  it("asks a url elicitation as a plain yes/no", async () => {
    const request: AcpElicitationRequest = {
      id: "dlg-5",
      mode: "url",
      message: "Finish signing in",
      url: "https://example.com/auth",
      raw: {},
    }

    const asked: AskUserRequest[] = []
    const accepted = await answerElicitationThroughAskUser(request, async (question) => {
      asked.push(question)
      return answer({ selected: ["true"] })
    })
    expect(asked[0].question).toBe("Finish signing in")
    expect(accepted).toEqual({ requestId: "dlg-5", action: "accept" })

    const declined = await answerElicitationThroughAskUser(request, async () =>
      answer({ selected: ["false"] })
    )
    expect(declined).toEqual({ requestId: "dlg-5", action: "decline" })

    const cancelled = await answerElicitationThroughAskUser(request, async () =>
      answer({ cancelled: true })
    )
    expect(cancelled).toEqual({ requestId: "dlg-5", action: "cancel" })
  })
})
