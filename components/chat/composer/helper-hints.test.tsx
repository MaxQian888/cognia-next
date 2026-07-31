/**
 * @jest-environment jsdom
 */
import { act, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { HelperHints } from "./helper-hints"
import { useChatStore } from "@/stores/chat"

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <NextIntlClientProvider locale="en" messages={{}}>
      {children}
    </NextIntlClientProvider>
  )
}

/** Put the store in "session `s1` is active and has `count` messages". */
function seedSession(count: number) {
  act(() => {
    useChatStore.setState({
      activeSessionId: "s1",
      sessions: {
        s1: {
          ...(useChatStore.getState().sessions.s1 ?? {}),
          messages: Array.from({ length: count }, (_, i) => ({ id: `m${i}` })),
        },
      },
    } as never)
  })
}

beforeEach(() => {
  act(() => {
    useChatStore.setState({ activeSessionId: null, sessions: {} } as never)
  })
})

describe("HelperHints", () => {
  it("renders shortcut hint chips on an unstarted conversation", () => {
    render(<HelperHints />, { wrapper: Wrapper })
    expect(screen.getByText(/Send/i)).toBeInTheDocument()
    expect(screen.getByText(/Drop/i)).toBeInTheDocument()
    expect(screen.getByText(/Try/i)).toBeInTheDocument()
  })

  it("still shows for a selected session that has no messages yet", () => {
    seedSession(0)
    render(<HelperHints />, { wrapper: Wrapper })
    expect(screen.getByText(/Send/i)).toBeInTheDocument()
  })

  // The row used to render on every desktop turn — the same three sentences
  // under the composer all day. It is onboarding, so the first reply retires it.
  it("retires itself once the conversation has started", () => {
    seedSession(2)
    const { container } = render(<HelperHints />, { wrapper: Wrapper })
    expect(container).toBeEmptyDOMElement()
  })

  it("hides on small viewports AND medium-width composer containers that still stack", () => {
    const { container } = render(<HelperHints />, { wrapper: Wrapper })
    const root = container.firstChild as HTMLElement
    expect(root.classList.contains("hidden")).toBe(true)
    // Stacked media + container variant: the hints need BOTH a ≥sm viewport
    // (keyboard-style hints are useless on touch) and a ≥@lg composer
    // container (a medium-width sidebar still uses the stacked composer and
    // shouldn't burn another row on hint chips).
    expect(root.classList.contains("sm:@lg/composer:flex")).toBe(true)
    expect(root.classList.contains("sm:@sm/composer:flex")).toBe(false)
    expect(root.classList.contains("sm:flex")).toBe(false)
  })
})
