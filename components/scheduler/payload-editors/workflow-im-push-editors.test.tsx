/**
 * @jest-environment jsdom
 *
 * Converter tests for the `workflow` and `im-push` structured payload drafts.
 * Component tests live in `workflow-payload-editor.test.tsx` and
 * `im-push-payload-editor.test.tsx`.
 */

import {
  DraftValidationError,
  EMPTY_IM_PUSH_DRAFT,
  EMPTY_WORKFLOW_DRAFT,
  imPushDraftToPayload,
  isStructuredEditableTaskType,
  payloadToImPushDraft,
  payloadToWorkflowDraft,
  workflowDraftToPayload,
  type ImPushDraft,
} from "./types"

describe("workflow converters", () => {
  it("round-trips a full payload", () => {
    const draft = payloadToWorkflowDraft({
      workflowId: "wf1",
      environment: "staging",
      inputs: { a: 1 },
      triggerId: "t1",
      idempotencyKey: "k",
    })
    expect(draft).toEqual({
      workflowId: "wf1",
      environment: "staging",
      inputsJson: JSON.stringify({ a: 1 }, null, 2),
      triggerId: "t1",
      idempotencyKey: "k",
    })
    expect(workflowDraftToPayload(draft)).toEqual({
      workflowId: "wf1",
      environment: "staging",
      inputs: { a: 1 },
      triggerId: "t1",
      idempotencyKey: "k",
    })
  })

  it("defaults on non-object payloads and omits empty optionals", () => {
    expect(payloadToWorkflowDraft(null)).toEqual(EMPTY_WORKFLOW_DRAFT)
    expect(payloadToWorkflowDraft([1])).toEqual(EMPTY_WORKFLOW_DRAFT)
    expect(workflowDraftToPayload({ ...EMPTY_WORKFLOW_DRAFT, workflowId: " wf2 " })).toEqual({
      workflowId: "wf2",
    })
  })

  it("tolerates unserialisable inputs when building the draft", () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(payloadToWorkflowDraft({ workflowId: "x", inputs: circular }).inputsJson).toBe("")
  })

  it("throws per-field validation errors", () => {
    expect(() => workflowDraftToPayload({ ...EMPTY_WORKFLOW_DRAFT })).toThrow(DraftValidationError)
    try {
      workflowDraftToPayload({ ...EMPTY_WORKFLOW_DRAFT, workflowId: "", inputsJson: "{nope" })
    } catch (e) {
      expect((e as DraftValidationError).errors).toEqual({
        workflowId: "workflowIdRequired",
        inputsJson: "inputsInvalidJson",
      })
    }
  })
})

describe("im-push converters", () => {
  it("round-trips text and segments payloads", () => {
    expect(
      payloadToImPushDraft({ conversationKey: "c1", text: "hi", idempotencyKey: "k" })
    ).toEqual({
      conversationKey: "c1",
      text: "hi",
      segmentsJson: "",
      idempotencyKey: "k",
    })
    const seg = [{ type: "text", text: "a" }]
    const draft = payloadToImPushDraft({ conversationKey: "c1", segments: seg })
    expect(draft.segmentsJson).toBe(JSON.stringify(seg, null, 2))
    expect(imPushDraftToPayload(draft)).toEqual({ conversationKey: "c1", segments: seg })
    expect(
      imPushDraftToPayload({ ...EMPTY_IM_PUSH_DRAFT, conversationKey: "c1", text: " hi " })
    ).toEqual({
      conversationKey: "c1",
      text: "hi",
    })
    expect(payloadToImPushDraft("nope")).toEqual(EMPTY_IM_PUSH_DRAFT)
  })

  it("validates conversation key, text/segments presence and segment shape", () => {
    const expectErrors = (draft: ImPushDraft, errors: Record<string, string>) => {
      try {
        imPushDraftToPayload(draft)
        throw new Error("expected DraftValidationError")
      } catch (e) {
        expect(e).toBeInstanceOf(DraftValidationError)
        expect((e as DraftValidationError).errors).toEqual(errors)
      }
    }
    expectErrors(
      { ...EMPTY_IM_PUSH_DRAFT },
      {
        conversationKey: "conversationKeyRequired",
        text: "imPushTextRequired",
      }
    )
    expectErrors(
      { ...EMPTY_IM_PUSH_DRAFT, conversationKey: "c", segmentsJson: "[" },
      {
        segmentsJson: "segmentsInvalid",
      }
    )
    expectErrors(
      { ...EMPTY_IM_PUSH_DRAFT, conversationKey: "c", segmentsJson: "[]" },
      {
        segmentsJson: "segmentsInvalid",
      }
    )
    expectErrors(
      { ...EMPTY_IM_PUSH_DRAFT, conversationKey: "c", segmentsJson: '[{"x":1}]' },
      {
        segmentsJson: "segmentsInvalid",
      }
    )
  })

  it("marks both new types as structured-editable", () => {
    expect(isStructuredEditableTaskType("workflow")).toBe(true)
    expect(isStructuredEditableTaskType("im-push")).toBe(true)
    expect(isStructuredEditableTaskType("script")).toBe(false)
  })
})
