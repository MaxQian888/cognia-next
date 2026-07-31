/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom"
import { fireEvent, render, waitFor } from "@testing-library/react"
import { createEditorStore } from "@/lib/workflow/editor/store"
import type { VisualWorkflow } from "@/types/workflow/visual"
import { ExpressionField } from "./expression-field"

const runOutputs = {
  start: { payload: { request: { id: "req-1" }, items: [{ sku: "sku-1" }] } },
}

jest.mock("@/hooks/workflow/use-latest-run-outputs", () => ({
  useLatestRunOutputs: () => runOutputs,
}))

jest.mock("./variable-picker", () => ({
  VariablePicker: () => null,
}))

beforeAll(() => {
  const rect = {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
    toJSON: () => ({}),
  }
  Range.prototype.getBoundingClientRect = () => rect as DOMRect
  Range.prototype.getClientRects = () =>
    ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as DOMRectList
  Element.prototype.getClientRects = Range.prototype.getClientRects
})

function workflow(): VisualWorkflow {
  return {
    id: "wf-expression-completion",
    schemaVersion: 1,
    name: "Expression completion",
    createdAt: 1,
    updatedAt: 1,
    nodes: [
      {
        id: "start",
        type: "trigger.manual",
        typeVersion: 1,
        position: { x: 0, y: 0 },
        data: {
          label: "Start",
          params: {
            inputSchema: {
              type: "object",
              properties: { declared: { type: "string" } },
            },
          },
        },
      },
      {
        id: "current",
        type: "ai.prompt",
        typeVersion: 1,
        position: { x: 200, y: 0 },
        data: { label: "Current", params: {} },
      },
    ],
    edges: [{ id: "start-current", source: "start", target: "current" }],
    variables: { API_KEY: "secret-ref" },
    staticData: { counter: 1 },
    settings: {
      errorPolicy: "stop",
      timeoutMs: 60_000,
      concurrency: 1,
      retryDefaults: { attempts: 3, backoff: "exponential", baseMs: 1_000 },
    },
  }
}

describe("ExpressionField", () => {
  it("offers variables, static data, trigger schemas, and latest trigger output", async () => {
    const store = createEditorStore(workflow())
    const { container } = render(
      <ExpressionField
        value="$"
        onChange={() => {}}
        store={store}
        currentNodeId="current"
        aria-label="expression"
      />
    )
    const content = container.querySelector<HTMLElement>(".cm-content")
    expect(content).not.toBeNull()
    content!.focus()
    fireEvent.keyDown(content!, { key: " ", code: "Space", ctrlKey: true })

    await waitFor(
      () => {
        const popup = document.querySelector(".cm-tooltip-autocomplete")
        expect(popup).toHaveTextContent("$vars.API_KEY")
        expect(popup).toHaveTextContent("$static.counter")
        expect(popup).toHaveTextContent("$trigger.payload.declared")
        expect(popup).toHaveTextContent("$trigger.payload.request.id")
        expect(popup).toHaveTextContent("$trigger.payload.items[0].sku")
      },
      { timeout: 1_000 }
    )
  })
})
