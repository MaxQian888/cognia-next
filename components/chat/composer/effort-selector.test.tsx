/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { EffortSelector } from "./effort-selector"
import type { ChatSession } from "@/lib/claude/types"
import { updateSession } from "@/lib/db/sessions"

// The selector persists effort through the Dexie sessions table.
jest.mock("@/lib/db/sessions", () => ({
  updateSession: jest.fn(async () => undefined),
}))
const mockedUpdateSession = updateSession as unknown as jest.Mock

// Settings store: no app-level defaults — the session carries model/provider.
jest.mock("@/stores/settings", () => ({
  useSettingsStore: <T,>(selector: (s: { settings: null }) => T) => selector({ settings: null }),
}))

// Flatten Radix dropdown primitives so the content is always visible and
// RadioItems are directly clickable in jsdom without pointer-event plumbing
// (the same approach used by `agent/mode/runtime-selector.test.tsx`). The
// trigger is `asChild`, so render its child (the real Button) verbatim.
jest.mock("@/components/ui/dropdown-menu", () => {
  const React = jest.requireActual("react")
  return {
    DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DropdownMenuRadioGroup: ({
      children,
      value,
      onValueChange,
    }: {
      children: React.ReactNode
      value: string
      onValueChange: (v: string) => void
    }) => (
      <div data-value={value}>
        {React.Children.map(children, (child: React.ReactElement<{ value: string }>) =>
          React.isValidElement(child)
            ? React.cloneElement(child, { onSelect: () => onValueChange(child.props.value) })
            : child
        )}
      </div>
    ),
    DropdownMenuRadioItem: ({
      children,
      value,
      onSelect,
    }: {
      children: React.ReactNode
      value: string
      onSelect?: () => void
    }) => (
      <div role="menuitemradio" aria-checked={false} data-value={value} onClick={onSelect}>
        {children}
      </div>
    ),
  }
})

const messages = {
  chat: { composer: { effort: { aria: "Thinking level", auto: "Auto" } } },
  settings: {
    general: {
      effort: { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
    },
  },
}

function renderSelector(session: ChatSession | null, disabled?: boolean) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <EffortSelector session={session} disabled={disabled} />
    </NextIntlClientProvider>
  )
}

// Effort-capable model (Sonnet 4.6 matches ANTHROPIC_EFFORT_FAMILIES).
const capableSession: ChatSession = {
  id: "ses_1",
  title: "t",
  kind: "direct",
  model: "claude-sonnet-4-6",
  providerOverride: "anthropic",
  effort: "high",
  createdAt: 0,
  updatedAt: 0,
}

beforeEach(() => mockedUpdateSession.mockClear())

describe("EffortSelector", () => {
  it("renders the trigger labelled with the current effort on a capable model", () => {
    renderSelector(capableSession)
    const trigger = screen.getByRole("button", { name: "Thinking level" })
    expect(trigger.textContent).toContain("high")
  })

  it("labels the trigger 'Auto' when effort is undefined", () => {
    renderSelector({ ...capableSession, effort: undefined })
    expect(screen.getByRole("button").textContent).toContain("Auto")
  })

  it("renders nothing when the active model does not support effort", () => {
    const { container } = renderSelector({ ...capableSession, model: "claude-sonnet-4-5" })
    expect(container).toBeEmptyDOMElement()
  })

  it("renders nothing when there is no session", () => {
    const { container } = renderSelector(null)
    expect(container).toBeEmptyDOMElement()
  })

  it("persists the chosen level via updateSession", () => {
    renderSelector(capableSession)
    fireEvent.click(screen.getByRole("menuitemradio", { name: "xhigh" }))
    expect(mockedUpdateSession).toHaveBeenCalledWith("ses_1", { effort: "xhigh" })
  })

  it("persists undefined when 'Auto' (use model default) is chosen", () => {
    renderSelector(capableSession)
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Auto" }))
    expect(mockedUpdateSession).toHaveBeenCalledWith("ses_1", { effort: undefined })
  })

  it("optimistically updates the trigger label after a selection", () => {
    renderSelector(capableSession)
    fireEvent.click(screen.getByRole("menuitemradio", { name: "max" }))
    // Label reflects the optimistic value without a new `session` prop.
    expect(screen.getByRole("button").textContent).toContain("max")
  })

  it("disables the trigger while streaming", () => {
    renderSelector(capableSession, true)
    expect(screen.getByRole("button")).toBeDisabled()
  })

  it("clears the optimistic overlay when the session changes", () => {
    const { rerender } = renderSelector(capableSession)
    fireEvent.click(screen.getByRole("menuitemradio", { name: "max" }))
    expect(screen.getByRole("button").textContent).toContain("max")
    // A different session id must reset the overlay so the new session's own
    // effort renders instead of the stale optimistic value.
    rerender(
      <NextIntlClientProvider locale="en" messages={messages}>
        <EffortSelector session={{ ...capableSession, id: "ses_2", effort: "low" }} />
      </NextIntlClientProvider>
    )
    expect(screen.getByRole("button").textContent).toContain("low")
  })
})
