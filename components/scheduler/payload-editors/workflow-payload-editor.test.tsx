/**
 * @jest-environment jsdom
 *
 * Component tests for the `workflow` structured payload editor. The workflow
 * list is injected through `loadWorkflows` so no Dexie is touched;
 * `useLiveQuery` is stubbed to run the loader once. Converters are covered in
 * `workflow-im-push-editors.test.tsx`.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { useState } from "react"
import { WorkflowPayloadEditor } from "./workflow-payload-editor"
import { EMPTY_WORKFLOW_DRAFT, type WorkflowDraft } from "./types"

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
