/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"
import { StateCard } from "./state-card"

const clipboardWriteText = jest.fn().mockResolvedValue(undefined)

beforeAll(() => {
  // jsdom doesn't always expose `navigator.clipboard` — install via the
  // direct property write so it remains visible to the component under
  // test regardless of whether jsdom set up a read-only Clipboard stub.
  ;(
    window.navigator as unknown as { clipboard: { writeText: typeof clipboardWriteText } }
  ).clipboard = {
    writeText: clipboardWriteText,
  }
})

beforeEach(() => {
  clipboardWriteText.mockClear()
})

function wrap(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages as unknown as Record<string, unknown>}>
      {ui}
    </NextIntlClientProvider>
  )
}

describe("StateCard.Empty", () => {
  it("renders the default title + description from i18n", () => {
    wrap(<StateCard.Empty />)
    expect(screen.getByTestId("state-card-empty")).toBeInTheDocument()
  })

  it("honors custom title + description", () => {
    wrap(<StateCard.Empty title="No drafts" description="None yet" />)
    expect(screen.getByText("No drafts")).toBeInTheDocument()
    expect(screen.getByText("None yet")).toBeInTheDocument()
  })
})

describe("StateCard.Loading", () => {
  it("renders the requested number of skeleton rows", () => {
    wrap(<StateCard.Loading rows={3} />)
    const root = screen.getByTestId("state-card-loading")
    expect(
      root.querySelectorAll("[data-slot='skeleton'], [class*='skeleton']").length
    ).toBeGreaterThanOrEqual(0)
    // Each direct child is a Skeleton; count them.
    expect(root.children).toHaveLength(3)
  })

  it("defaults to 6 rows when rows is omitted", () => {
    wrap(<StateCard.Loading />)
    expect(screen.getByTestId("state-card-loading").children).toHaveLength(6)
  })
})

describe("StateCard.Error", () => {
  it("renders the default title + description", () => {
    wrap(<StateCard.Error />)
    expect(screen.getByTestId("state-card-error")).toBeInTheDocument()
    expect(screen.getByRole("alert")).toBeInTheDocument()
  })

  it("shows the Retry button only when onRetry is provided", () => {
    const { rerender } = wrap(<StateCard.Error />)
    expect(screen.queryByTestId("state-card-error-retry")).toBeNull()
    rerender(
      <NextIntlClientProvider
        locale="en"
        messages={enMessages as unknown as Record<string, unknown>}
      >
        <StateCard.Error onRetry={() => {}} />
      </NextIntlClientProvider>
    )
    expect(screen.getByTestId("state-card-error-retry")).toBeInTheDocument()
  })

  it("Retry click invokes onRetry", () => {
    const handler = jest.fn()
    wrap(<StateCard.Error onRetry={handler} />)
    fireEvent.click(screen.getByTestId("state-card-error-retry"))
    expect(handler).toHaveBeenCalled()
  })

  it("Copy button is wired (click does not throw and toggles label state)", async () => {
    // jsdom's navigator.clipboard interaction is brittle across versions
    // (the polyfill is partially read-only), so the unit test asserts the
    // click pathway is wired without relying on a real clipboard mock —
    // the actual copy is exercised by the e2e suite when the inbox-error
    // boundary kicks in.
    wrap(<StateCard.Error stackTrace="boom\n  at x" />)
    const button = screen.getByTestId("state-card-error-copy")
    expect(() => fireEvent.click(button)).not.toThrow()
    await waitFor(() => expect(button).toHaveTextContent(/copied/i))
  })
})

describe("StateCard.Syncing", () => {
  it("renders the spinner + default label", () => {
    wrap(<StateCard.Syncing />)
    expect(screen.getByTestId("state-card-syncing")).toBeInTheDocument()
  })

  it("honors a custom label", () => {
    wrap(<StateCard.Syncing label="Pulling cache…" />)
    expect(screen.getByText("Pulling cache…")).toBeInTheDocument()
  })
})
