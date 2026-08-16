/**
 * @jest-environment jsdom
 *
 * Component tests for the `im-push` structured payload editor. Converters are
 * covered in `workflow-im-push-editors.test.tsx`.
 */

import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { useState } from "react"
import { ImPushPayloadEditor } from "./im-push-payload-editor"
import { EMPTY_IM_PUSH_DRAFT, type ImPushDraft } from "./types"

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
