/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
const toastSuccess = jest.fn()
jest.mock("sonner", () => ({ toast: { success: (...a: unknown[]) => toastSuccess(...a) } }))

import { ChatTemplatesSection } from "./chat-templates-section"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { createChatTemplate, getChatTemplate, listChatTemplates } from "@/lib/db/chat-templates"

beforeEach(async () => {
  toastSuccess.mockClear()
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
}, 30_000)

async function mount() {
  await act(async () => {
    render(<ChatTemplatesSection />)
  })
}

describe("ChatTemplatesSection", () => {
  it("says so when nothing has been saved", async () => {
    await mount()

    expect(screen.getByText("empty")).toBeInTheDocument()
  })

  it("lists a template with its parameters", async () => {
    await createChatTemplate({ name: "Review a PR", body: "review {{module}} on {{branch}}" })

    await mount()

    await waitFor(() => expect(screen.getByText("Review a PR")).toBeInTheDocument())
    expect(screen.getByText("module")).toBeInTheDocument()
    expect(screen.getByText("branch")).toBeInTheDocument()
  })

  it("edits the body and re-derives what the template asks for", async () => {
    // Saving used to be a one-way door: a typo in the body was permanent.
    const row = await createChatTemplate({ name: "Review", body: "review {{module}}" })
    await mount()
    await waitFor(() => expect(screen.getByText("Review")).toBeInTheDocument())

    fireEvent.click(screen.getByRole("button", { name: "edit" }))
    fireEvent.change(screen.getByLabelText("body"), {
      target: { value: "review {{module}} on {{branch}}" },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "save" }))
    })

    await waitFor(async () => {
      const stored = await getChatTemplate(row.id)
      expect(stored?.body).toBe("review {{module}} on {{branch}}")
      expect(stored?.params.map((p) => p.id)).toEqual(["module", "branch"])
      // A content edit invalidates drafts that quoted the old body.
      expect(stored?.revision).toBe(2)
    })
  })

  it("deletes a template", async () => {
    await createChatTemplate({ name: "Review", body: "x" })
    await mount()
    await waitFor(() => expect(screen.getByText("Review")).toBeInTheDocument())

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "delete" }))
    })

    await waitFor(async () => expect(await listChatTemplates()).toEqual([]))
  })
})
