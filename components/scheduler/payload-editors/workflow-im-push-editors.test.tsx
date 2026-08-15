/**
 * @jest-environment jsdom
 *
 * Component + converter tests for the `workflow` and `im-push` structured
 * payload editors. The workflow list is injected through `loadWorkflows` so
 * no Dexie is touched; `useLiveQuery` is stubbed to run the loader once.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { useState } from "react"
import { WorkflowPayloadEditor } from "./workflow-payload-editor"
import { ImPushPayloadEditor } from "./im-push-payload-editor"
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
  type WorkflowDraft,
} from "./types"

const liveQueryState: { rows: unknown } = { rows: undefined }
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (loader: () => Promise<unknown>) => {
    // Resolve synchronously-ish for tests: kick the loader and expose the
    // last resolved value through module state.
    void Promise.resolve(loader()).then((rows) => {
      liveQueryState.rows = rows
    })
    return liveQueryState.rows
  },
}))
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    workflows: { toArray: async () => [{ id: "wf-db", name: "From Dexie" }] },
  }),
}))

const messages = {
  scheduler: {
    payload: {
      workflow: {
        workflowId: "Workflow",
        workflowPlaceholder: "Pick a workflow",
        noWorkflows: "No workflows",
        workflowIdManual: "Workflow id",
        workflowIdManualPlaceholder: "paste id",
        unknownWorkflowHint: "unknown id",
        deploymentHelp: "needs deployment",
        environment: "Environment",
        triggerId: "Trigger node id",
        triggerIdPlaceholder: "Optional",
        triggerIdHelp: "cron node",
        inputs: "Inputs (JSON)",
        inputsHelp: "payload",
        idempotencyKey: "Idempotency key",
        idempotencyKeyPlaceholder: "default",
        idempotencyKeyHelp: "reuse",
      },
      imPush: {
        conversationKey: "Conversation key",
        conversationKeyPlaceholder: "lark:oc",
        conversationKeyHelp: "bound conversation",
        text: "Message",
        textPlaceholder: "text",
        textIgnoredHint: "ignored while segments",
        segments: "Raw segments",
        segmentsHelp: "advanced",
        idempotencyKey: "Idempotency key",
        idempotencyKeyPlaceholder: "default",
        guardrails: "guardrails",
      },
      errors: {
        workflowIdRequired: "Workflow is required",
        inputsInvalidJson: "Inputs must be valid JSON",
        conversationKeyRequired: "Conversation key is required",
        segmentsInvalid: "Segments invalid",
        imPushTextRequired: "Message text is required",
      },
    },
  },
}

function wrap(ui: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={messages}>
      {ui}
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  liveQueryState.rows = undefined
})

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

describe("WorkflowPayloadEditor", () => {
  it("lists workflows from the loader and accepts a pasted id with a hint", async () => {
    function Host() {
      const [draft, setDraft] = useState<WorkflowDraft>({ ...EMPTY_WORKFLOW_DRAFT })
      return (
        <WorkflowPayloadEditor
          draft={draft}
          onDraftChange={setDraft}
          loadWorkflows={async () => [{ id: "wf-a", name: "Alpha" }]}
        />
      )
    }
    render(wrap(<Host />))
    await waitFor(() => expect(liveQueryState.rows).toBeDefined())
    const idInput = screen.getByTestId(
      "workflow-payload-editor-workflow-id-input"
    ) as HTMLInputElement
    fireEvent.change(idInput, { target: { value: "wf-zzz" } })
    expect(idInput.value).toBe("wf-zzz")
    expect(await screen.findByText(/not in the local workflow list/)).toBeInTheDocument()

    fireEvent.change(screen.getByTestId("workflow-payload-editor-environment-input"), {
      target: { value: "staging" },
    })
    fireEvent.change(screen.getByTestId("workflow-payload-editor-trigger-id-input"), {
      target: { value: "trig" },
    })
    fireEvent.change(screen.getByTestId("workflow-payload-editor-inputs-input"), {
      target: { value: '{"a":1}' },
    })
    fireEvent.change(screen.getByTestId("workflow-payload-editor-idempotency-input"), {
      target: { value: "key" },
    })
    expect(
      (screen.getByTestId("workflow-payload-editor-idempotency-input") as HTMLInputElement).value
    ).toBe("key")
  })

  it("renders field errors and the default Dexie loader", async () => {
    render(
      wrap(
        <WorkflowPayloadEditor
          draft={{ ...EMPTY_WORKFLOW_DRAFT, inputsJson: "{" }}
          onDraftChange={() => {}}
          errors={{ workflowId: "workflowIdRequired", inputsJson: "inputsInvalidJson" }}
        />
      )
    )
    expect(screen.getByText(/Workflow is required/)).toBeInTheDocument()
    expect(screen.getByText(/Inputs must be valid JSON/)).toBeInTheDocument()
    await waitFor(() => expect(liveQueryState.rows).toEqual([{ id: "wf-db", name: "From Dexie" }]))
  })
})

describe("ImPushPayloadEditor", () => {
  it("edits every field and disables text while segments are provided", () => {
    function Host() {
      const [draft, setDraft] = useState<ImPushDraft>({ ...EMPTY_IM_PUSH_DRAFT })
      return <ImPushPayloadEditor draft={draft} onDraftChange={setDraft} />
    }
    render(wrap(<Host />))
    fireEvent.change(screen.getByTestId("im-push-payload-editor-conversation-input"), {
      target: { value: "lark:oc_1" },
    })
    fireEvent.change(screen.getByTestId("im-push-payload-editor-text-input"), {
      target: { value: "hello" },
    })
    fireEvent.change(screen.getByTestId("im-push-payload-editor-idempotency-input"), {
      target: { value: "k1" },
    })
    const text = screen.getByTestId("im-push-payload-editor-text-input") as HTMLTextAreaElement
    expect(text.value).toBe("hello")
    expect(text.disabled).toBe(false)
    fireEvent.change(screen.getByTestId("im-push-payload-editor-segments-input"), {
      target: { value: '[{"type":"text","text":"x"}]' },
    })
    expect(
      (screen.getByTestId("im-push-payload-editor-text-input") as HTMLTextAreaElement).disabled
    ).toBe(true)
    expect(screen.getByText(/Ignored while raw segments/)).toBeInTheDocument()
    expect(screen.getByText(/^Guardrails:/)).toBeInTheDocument()
  })

  it("renders field errors", () => {
    render(
      wrap(
        <ImPushPayloadEditor
          draft={{ ...EMPTY_IM_PUSH_DRAFT }}
          onDraftChange={() => {}}
          errors={{
            conversationKey: "conversationKeyRequired",
            text: "imPushTextRequired",
            segmentsJson: "segmentsInvalid",
          }}
        />
      )
    )
    expect(screen.getByText(/Conversation key is required/)).toBeInTheDocument()
    expect(screen.getByText(/Message text \(or segments\) is required/)).toBeInTheDocument()
    expect(screen.getByText(/Segments must be a non-empty JSON array/)).toBeInTheDocument()
  })
})
