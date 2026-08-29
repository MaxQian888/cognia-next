/**
 * @jest-environment jsdom
 *
 * Coverage for the node-level credential binding.
 *
 * The workflow settings panel has always let authors declare credential
 * references, `checkCredentials` validated node bindings against that list,
 * and the keyring resolver was wired as the orchestrator default — but no node
 * could ever be bound to one, because the inspector offered no control and the
 * AI executors read the map off `params` instead of the node's `data`. This
 * suite pins the authoring half.
 */
import { fireEvent, render, screen, within } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"
import { createEditorStore, type EditorStore } from "@/lib/workflow/editor/store"
import { DEFAULT_WORKFLOW_SETTINGS, type VisualWorkflow } from "@/types/workflow/visual"
import { InspectorExpressionProvider } from "./shared/inspector-context"
import { CredentialRefField } from "./form-support"
import { useTranslations } from "next-intl"

// Radix Select drives pointer-capture + scrollIntoView, which jsdom lacks.
beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = jest.fn()
  window.HTMLElement.prototype.hasPointerCapture = jest.fn(() => false) as never
  window.HTMLElement.prototype.releasePointerCapture = jest.fn() as never
})

function makeWorkflow(credentials?: VisualWorkflow["credentials"]): VisualWorkflow {
  return {
    id: "wf",
    schemaVersion: 1,
    name: "t",
    createdAt: 0,
    updatedAt: 0,
    nodes: [
      {
        id: "n1",
        type: "ai.prompt",
        typeVersion: 1,
        position: { x: 0, y: 0 },
        data: { label: "n1", params: { userPrompt: "hi" } },
      },
    ],
    edges: [],
    settings: DEFAULT_WORKFLOW_SETTINGS,
    ...(credentials ? { credentials } : {}),
  }
}

function Harness({ store, inlineValueSet }: { store: EditorStore; inlineValueSet?: boolean }) {
  const t = useTranslations("workflows.forms.aiPrompt")
  return (
    <InspectorExpressionProvider store={store} currentNodeId="n1">
      <CredentialRefField slot="apiKey" id="cred" t={t} inlineValueSet={inlineValueSet} />
    </InspectorExpressionProvider>
  )
}

function renderField(wf: VisualWorkflow, inlineValueSet?: boolean) {
  const store = createEditorStore(wf)
  const utils = render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <Harness store={store} inlineValueSet={inlineValueSet} />
    </NextIntlClientProvider>
  )
  return { store, ...utils }
}

describe("CredentialRefField", () => {
  it("stays visible but disabled when the workflow declares no credentials", () => {
    const { container } = renderField(makeWorkflow())
    const field = container.querySelector('[data-field="credentialRef"]')
    // Hiding it would merge "this node cannot use a credential" with "you have
    // not declared one yet"; only the second is true, so say which.
    expect(field).not.toBeNull()
    expect(within(field as HTMLElement).getByRole("combobox")).toBeDisabled()
    expect(field!.textContent).toContain("No credentials declared yet")
  })

  it("writes the binding to node data, not params", () => {
    const { store } = renderField(makeWorkflow({ "cred-1": { id: "cred-1", name: "OpenAI key" } }))
    fireEvent.click(screen.getByRole("combobox"))
    fireEvent.click(screen.getByRole("option", { name: "OpenAI key" }))

    const node = store.getState().nodes.find((n) => n.id === "n1")!
    expect(node.data.credentialRefs).toEqual({ apiKey: "cred-1" })
    expect(node.data.params).toEqual({ userPrompt: "hi" })
  })

  it("shows the stored binding and clears it back to none", () => {
    const wf = makeWorkflow({ "cred-1": { id: "cred-1", name: "OpenAI key" } })
    wf.nodes[0]!.data.credentialRefs = { apiKey: "cred-1" }
    const { store } = renderField(wf)
    expect(screen.getByRole("combobox")).toHaveTextContent("OpenAI key")

    fireEvent.click(screen.getByRole("combobox"))
    fireEvent.click(screen.getByRole("option", { name: "None" }))
    // An empty map is dropped entirely rather than persisted as `{}`.
    expect(store.getState().nodes[0]!.data.credentialRefs).toBeUndefined()
  })

  it("warns that a typed-in key overrides the binding at run time", () => {
    const wf = makeWorkflow({ "cred-1": { id: "cred-1", name: "OpenAI key" } })
    wf.nodes[0]!.data.credentialRefs = { apiKey: "cred-1" }
    const { container } = renderField(wf, true)
    expect(container.textContent).toContain("The key typed above wins at run time")
  })

  it("renders nothing without an inspector provider (headless / story)", () => {
    function Bare() {
      const t = useTranslations("workflows.forms.aiPrompt")
      return <CredentialRefField slot="apiKey" id="cred" t={t} />
    }
    const { container } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <Bare />
      </NextIntlClientProvider>
    )
    expect(container.firstChild).toBeNull()
  })
})
