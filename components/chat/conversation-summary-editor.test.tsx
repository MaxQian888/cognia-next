/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import enChat from "@/i18n/messages/en/chat.json"
import { ConversationSummaryEditor } from "./conversation-summary-editor"

function renderEditor(props: Partial<Parameters<typeof ConversationSummaryEditor>[0]> = {}) {
  const onTextChange = jest.fn()
  const onRegenerate = jest.fn()
  render(
    <NextIntlClientProvider locale="en" messages={{ chat: enChat }}>
      <ConversationSummaryEditor
        label="Background"
        text="draft"
        onTextChange={onTextChange}
        generating={false}
        fallback={null}
        onRegenerate={onRegenerate}
        {...props}
      />
    </NextIntlClientProvider>
  )
  return { onTextChange, onRegenerate }
}

describe("ConversationSummaryEditor", () => {
  it("edits the draft under its label and regenerates on request", () => {
    const { onTextChange, onRegenerate } = renderEditor()
    const box = screen.getByLabelText("Background")
    fireEvent.change(box, { target: { value: "edited" } })
    expect(onTextChange).toHaveBeenCalledWith("edited")
    fireEvent.click(screen.getByRole("button", { name: enChat.branch.summary.regenerate }))
    expect(onRegenerate).toHaveBeenCalled()
  })

  it("uses the caller's button label when given one", () => {
    renderEditor({ regenerateLabel: "Draft it" })
    expect(screen.getByRole("button", { name: "Draft it" })).toBeInTheDocument()
  })

  it("says why the draft is only a digest, and hides that while generating", () => {
    renderEditor({ fallback: "no-client" })
    expect(screen.getByRole("status")).toHaveTextContent(enChat.branch.summary.fallback.noClient)
  })

  it("locks the text while a draft is generating", () => {
    renderEditor({ generating: true, fallback: "pii" })
    expect(screen.getByLabelText("Background")).toBeDisabled()
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
  })
})
