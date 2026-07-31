import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { TooltipProvider } from "@/components/ui/tooltip"
import { ComposerLinkChips } from "./link-context"

const messages = {
  chat: {
    composer: {
      links: {
        limitNote: "Reading the first {max} of {total} links",
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

  it("says how many links are actually read once past the cap", () => {
    render(
      <Providers>
        <ComposerLinkChips
          text="https://a.dev https://b.dev https://c.dev https://d.dev https://e.dev"
          onRemove={jest.fn()}
        />
      </Providers>
    )

    // Only the first 3 are chipped and dereferenced; the note keeps that from
    // being silent, since the other URLs still ship verbatim in the prompt.
    expect(screen.getAllByRole("link")).toHaveLength(3)
    expect(screen.getByText("Reading the first 3 of 5 links")).toBeInTheDocument()
  })

  it("stays quiet at or below the cap", () => {
    render(
      <Providers>
        <ComposerLinkChips text="https://a.dev https://b.dev" onRemove={jest.fn()} />
      </Providers>
    )

    expect(screen.queryByText(/Reading the first/)).toBeNull()
  })
})
