import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { TooltipProvider } from "@/components/ui/tooltip"
import { ComposerLinkButton, ComposerLinkChips } from "./link-context"

const messages = {
  chat: {
    composer: {
      links: {
        add: "Add link",
        addAction: "Attach link",
        inputAria: "Web address",
        inputPlaceholder: "https://example.com",
        invalid: "Enter a valid HTTP(S) link.",
        openAria: "Open {host}",
        removeAria: "Remove {host}",
      },
    },
  },
}

function Providers({ children }: { children: React.ReactNode }) {
  return (
    <NextIntlClientProvider locale="en" messages={messages}>
      <TooltipProvider>{children}</TooltipProvider>
    </NextIntlClientProvider>
  )
}

describe("composer link context", () => {
  it("renders no chip container when the draft has no links", () => {
    const { container } = render(
      <Providers>
        <ComposerLinkChips text="A prompt without links" onRemove={jest.fn()} />
      </Providers>
    )

    expect(container).toBeEmptyDOMElement()
  })

  it("renders de-duplicated link chips and removes the selected source", () => {
    const onRemove = jest.fn()
    render(
      <Providers>
        <ComposerLinkChips
          text="https://example.com/docs and https://example.com/docs"
          onRemove={onRemove}
        />
      </Providers>
    )

    expect(screen.getAllByText("example.com")).toHaveLength(1)
    fireEvent.click(screen.getByRole("button", { name: "Remove example.com" }))
    expect(onRemove).toHaveBeenCalledWith("https://example.com/docs")
  })

  it("validates and submits a web link from the toolbar popover", () => {
    const onAdd = jest.fn()
    render(
      <Providers>
        <ComposerLinkButton onAdd={onAdd} />
      </Providers>
    )

    fireEvent.click(screen.getByRole("button", { name: "Attach a link" }))
    const input = screen.getByRole("textbox", { name: "Web address" })
    fireEvent.change(input, { target: { value: "file:///tmp/private" } })
    fireEvent.click(screen.getByRole("button", { name: "Attach link" }))
    expect(screen.getByText("Enter a valid HTTP(S) link.")).toBeInTheDocument()
    expect(onAdd).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: "https://docs.example.com/start" } })
    fireEvent.click(screen.getByRole("button", { name: "Attach link" }))
    expect(onAdd).toHaveBeenCalledWith("https://docs.example.com/start")
  })
})
