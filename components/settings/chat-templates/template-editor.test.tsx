/** @jest-environment jsdom */

// The editor owns the create/edit form and the AI assist row. The assist hook
// is mocked to a controllable stub; what these tests pin is the contract:
// results land in the FORM (unsaved), errors become toasts, and Save is still
// the only commit point.

import "fake-indexeddb/auto"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))
const toastSuccess = jest.fn()
const toastError = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}))

const assistState = {
  running: false,
  op: null as string | null,
}
const assistGenerate = jest.fn()
const assistImprove = jest.fn()
const assistSuggest = jest.fn()
const assistCancel = jest.fn()
jest.mock("@/hooks/chat/use-template-assist", () => ({
  useTemplateAssist: () => ({
    ...assistState,
    generate: (...a: unknown[]) => assistGenerate(...a),
    improve: (...a: unknown[]) => assistImprove(...a),
    suggest: (...a: unknown[]) => assistSuggest(...a),
    cancel: () => assistCancel(),
  }),
}))

// The module namespace is frozen, so a write failure is injected by wrapping
// updateChatTemplate rather than spying on it.
const updateChatTemplateMock = jest.fn()
jest.mock("@/lib/db/chat-templates", () => {
  const actual =
    jest.requireActual<typeof import("@/lib/db/chat-templates")>("@/lib/db/chat-templates")
  return {
    ...actual,
    updateChatTemplate: (...a: Parameters<typeof actual.updateChatTemplate>) =>
      updateChatTemplateMock(...a),
  }
})
const realUpdateChatTemplate =
  jest.requireActual<typeof import("@/lib/db/chat-templates")>(
    "@/lib/db/chat-templates"
  ).updateChatTemplate

import { ChatTemplateEditor } from "./template-editor"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { createChatTemplate, listChatTemplates } from "@/lib/db/chat-templates"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
afterAll(dbFixture.dispose)
beforeEach(async () => {
  jest.clearAllMocks()
  assistState.running = false
  assistState.op = null
  updateChatTemplateMock.mockImplementation(realUpdateChatTemplate)
  await dbFixture.restore()
})

describe("ChatTemplateEditor", () => {
  it("creates a template on save", async () => {
    render(<ChatTemplateEditor mobile={false} onCancel={jest.fn()} onSaved={jest.fn()} />)

    fireEvent.change(screen.getByLabelText("name"), { target: { value: "Standup" } })
    fireEvent.change(screen.getByLabelText("body"), { target: { value: "did {{what}}" } })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "save" }))
    })

    const rows = await listChatTemplates()
    expect(rows).toHaveLength(1)
    expect(rows[0].params[0].id).toBe("what")
  })

  it("refuses to save without a name and a body", () => {
    render(<ChatTemplateEditor mobile={false} onCancel={jest.fn()} onSaved={jest.fn()} />)
    expect(screen.getByRole("button", { name: "save" })).toBeDisabled()
  })

  it("saves a patched declaration and description with the template", async () => {
    const row = await createChatTemplate({
      name: "Review",
      body: "review {{module}}",
      params: [{ id: "module", label: "module", required: true, kind: "string" }],
    })
    render(<ChatTemplateEditor row={row} mobile={false} onCancel={jest.fn()} onSaved={jest.fn()} />)

    fireEvent.change(screen.getByLabelText("description"), {
      target: { value: "weekly pass" },
    })
    fireEvent.click(screen.getByRole("button", { name: /customizeParams/ }))
    fireEvent.change(screen.getByLabelText("paramLabel"), {
      target: { value: "Which module" },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "save" }))
    })

    const stored = (await listChatTemplates())[0]
    expect(stored.description).toBe("weekly pass")
    expect(stored.params[0].label).toBe("Which module")
  })

  it("generate fills the form but does not save it", async () => {
    const onSaved = jest.fn()
    assistGenerate.mockResolvedValue({
      ok: true,
      value: {
        name: "AI draft",
        description: "made by ai",
        body: "ask about {{topic}}",
      },
    })
    render(<ChatTemplateEditor mobile={false} onCancel={jest.fn()} onSaved={onSaved} />)

    fireEvent.change(screen.getByLabelText("aiIntentPlaceholder"), {
      target: { value: "a question template" },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "aiGenerate" }))
    })

    expect(screen.getByLabelText("name")).toHaveValue("AI draft")
    expect(screen.getByLabelText("body")).toHaveValue("ask about {{topic}}")
    // Reviewed-but-not-saved: the table must still be empty.
    expect(await listChatTemplates()).toEqual([])
    expect(onSaved).not.toHaveBeenCalled()
  })

  it("improve replaces the body with the rewrite", async () => {
    assistImprove.mockResolvedValue({ ok: true, value: "tighter {{module}} wording" })
    const row = await createChatTemplate({ name: "Review", body: "review {{module}}" })
    render(<ChatTemplateEditor row={row} mobile={false} onCancel={jest.fn()} onSaved={jest.fn()} />)

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "aiImprove" }))
    })

    expect(screen.getByLabelText("body")).toHaveValue("tighter {{module}} wording")
  })

  it("passes the intent box to improve as the instruction", async () => {
    assistImprove.mockResolvedValue({ ok: true, value: "formal review {{module}}" })
    const row = await createChatTemplate({ name: "Review", body: "review {{module}}" })
    render(<ChatTemplateEditor row={row} mobile={false} onCancel={jest.fn()} onSaved={jest.fn()} />)

    fireEvent.change(screen.getByLabelText("aiIntentPlaceholder"), {
      target: { value: "make it formal" },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "aiImprove" }))
    })

    expect(assistImprove).toHaveBeenCalledWith("review {{module}}", "make it formal")
  })

  it("suggest merges declarations and opens the disclosure so they are visible", async () => {
    assistSuggest.mockResolvedValue({
      ok: true,
      value: [{ id: "module", label: "Which module", required: false, kind: "string" }],
    })
    const row = await createChatTemplate({ name: "Review", body: "review {{module}}" })
    render(<ChatTemplateEditor row={row} mobile={false} onCancel={jest.fn()} onSaved={jest.fn()} />)

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "aiSuggestSlots" }))
    })

    // The disclosure opened and the suggested label is in the field.
    await waitFor(() => expect(screen.getByLabelText("paramLabel")).toHaveValue("Which module"))
  })

  it("toasts the PII refusal distinctly from a generic failure", async () => {
    assistGenerate.mockResolvedValue({ ok: false, kind: "pii-blocked", error: "blocked" })
    render(<ChatTemplateEditor mobile={false} onCancel={jest.fn()} onSaved={jest.fn()} />)

    fireEvent.change(screen.getByLabelText("aiIntentPlaceholder"), { target: { value: "x" } })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "aiGenerate" }))
    })

    expect(toastError).toHaveBeenCalledWith("aiPiiBlocked")
  })

  it("toasts a plain failure with the error attached", async () => {
    assistImprove.mockResolvedValue({ ok: false, kind: "failed", error: "provider down" })
    const row = await createChatTemplate({ name: "Review", body: "review {{module}}" })
    render(<ChatTemplateEditor row={row} mobile={false} onCancel={jest.fn()} onSaved={jest.fn()} />)

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "aiImprove" }))
    })

    expect(toastError).toHaveBeenCalledWith("aiFailed")
  })

  it("runs generate when Enter lands in the intent box", async () => {
    assistGenerate.mockResolvedValue({ ok: true, value: { name: "N", body: "b" } })
    render(<ChatTemplateEditor mobile={false} onCancel={jest.fn()} onSaved={jest.fn()} />)

    fireEvent.change(screen.getByLabelText("aiIntentPlaceholder"), { target: { value: "x" } })
    await act(async () => {
      fireEvent.keyDown(screen.getByLabelText("aiIntentPlaceholder"), { key: "Enter" })
    })

    expect(assistGenerate).toHaveBeenCalledWith("x")
  })

  const OP_LABELS = {
    improve: "aiImprove",
    generate: "aiGenerate",
    suggest: "aiSuggestSlots",
  } as const

  it.each(["improve", "generate", "suggest"] as const)(
    "while %s runs, its button becomes the stop and the others disable",
    (op) => {
      assistState.running = true
      assistState.op = op
      render(<ChatTemplateEditor mobile={false} onCancel={jest.fn()} onSaved={jest.fn()} />)

      // The running op swapped its label for the cancel affordance.
      const stops = screen
        .getAllByRole("button", { name: "cancel" })
        .filter((button) => button.querySelector(".animate-spin"))
      expect(stops).toHaveLength(1)
      for (const label of Object.values(OP_LABELS).filter((l) => l !== OP_LABELS[op])) {
        expect(screen.getByRole("button", { name: label })).toBeDisabled()
      }
    }
  )

  it.each(["improve", "generate", "suggest"] as const)(
    "clicking the running %s button cancels it instead of restarting",
    async (op) => {
      assistState.running = true
      assistState.op = op
      const row = await createChatTemplate({ name: "Review", body: "review {{module}}" })
      render(
        <ChatTemplateEditor row={row} mobile={false} onCancel={jest.fn()} onSaved={jest.fn()} />
      )
      // The intent box needs text for generate's button to be live at all.
      fireEvent.change(screen.getByLabelText("aiIntentPlaceholder"), { target: { value: "x" } })

      const stop = screen
        .getAllByRole("button", { name: "cancel" })
        .find((button) => button.querySelector(".animate-spin"))
      expect(stop).toBeDefined()
      fireEvent.click(stop!)

      expect(assistCancel).toHaveBeenCalled()
      expect(assistGenerate).not.toHaveBeenCalled()
      expect(assistImprove).not.toHaveBeenCalled()
      expect(assistSuggest).not.toHaveBeenCalled()
    }
  )

  it.each(["generate", "improve", "suggest"] as const)(
    "a cancelled %s resolves null and stays silent",
    async (op) => {
      const mocks = {
        generate: assistGenerate,
        improve: assistImprove,
        suggest: assistSuggest,
      }
      mocks[op].mockResolvedValue(null)
      const row = await createChatTemplate({ name: "Review", body: "review {{module}}" })
      render(
        <ChatTemplateEditor row={row} mobile={false} onCancel={jest.fn()} onSaved={jest.fn()} />
      )
      fireEvent.change(screen.getByLabelText("aiIntentPlaceholder"), { target: { value: "x" } })

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: OP_LABELS[op] }))
      })

      expect(toastError).not.toHaveBeenCalled()
      // Nothing landed in the form either.
      expect(screen.getByLabelText("body")).toHaveValue("review {{module}}")
    }
  )

  it("keeps the form and toasts when the save write fails", async () => {
    const row = await createChatTemplate({ name: "Review", body: "review {{module}}" })
    updateChatTemplateMock.mockRejectedValueOnce(new Error("dexie down"))
    render(<ChatTemplateEditor row={row} mobile={false} onCancel={jest.fn()} onSaved={jest.fn()} />)

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "save" }))
    })

    expect(toastError).toHaveBeenCalledWith("saveFailed")
    // The form is untouched — the user can retry without retyping.
    expect(screen.getByLabelText("name")).toHaveValue("Review")
  })
})
