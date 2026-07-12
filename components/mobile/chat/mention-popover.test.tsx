import { fireEvent, render, screen } from "@testing-library/react"
import type { Character } from "@/lib/claude/types"
import { MentionPopover } from "./mention-popover"

const mkCharacter = (overrides: Partial<Character> = {}): Character => ({
  id: "char_a",
  name: "Alice",
  systemPrompt: "",
  avatarColor: "#000",
  isBuiltIn: false,
  createdAt: 0,
  updatedAt: 0,
  ...overrides,
})

describe("MentionPopover", () => {
  it("renders nothing when open is false", () => {
    const { container } = render(
      <MentionPopover
        open={false}
        query=""
        members={[mkCharacter()]}
        onPick={() => undefined}
        onDismiss={() => undefined}
      />
    )
    expect(container.querySelector('[data-testid="mobile-mention-popover"]')).toBeNull()
  })

  it("renders nothing when open is true but members is empty (rendered as empty hint)", () => {
    render(
      <MentionPopover
        open={true}
        query=""
        members={[]}
        onPick={() => undefined}
        onDismiss={() => undefined}
      />
    )
    expect(screen.getByTestId("mobile-mention-popover")).toBeInTheDocument()
    expect(screen.getByText(/no members/i)).toBeInTheDocument()
  })

  it("does not steal focus from the composer when it opens (non-modal)", () => {
    // The picker opens while the user is typing an @-query — if the Sheet
    // grabbed focus, the textarea would blur and the virtual keyboard would
    // dismiss, making type-to-filter impossible.
    render(
      <div>
        <textarea data-testid="fake-composer" />
        <MentionPopover
          open={true}
          query=""
          members={[mkCharacter()]}
          onPick={() => undefined}
          onDismiss={() => undefined}
        />
      </div>
    )
    const composer = screen.getByTestId("fake-composer")
    composer.focus()
    expect(composer).toHaveFocus()
    // Re-render with the sheet open (simulates the open transition settling).
    fireEvent.input(composer, { target: { value: "@al" } })
    expect(screen.getByTestId("mobile-mention-popover")).toBeInTheDocument()
    expect(composer).toHaveFocus()
  })

  it("lists members when open and at least one matches", () => {
    render(
      <MentionPopover
        open={true}
        query=""
        members={[mkCharacter({ id: "a", name: "Alice" }), mkCharacter({ id: "b", name: "Bob" })]}
        onPick={() => undefined}
        onDismiss={() => undefined}
      />
    )
    expect(screen.getByText("Alice")).toBeInTheDocument()
    expect(screen.getByText("Bob")).toBeInTheDocument()
  })

  it("filters case-insensitively by query against the name", () => {
    render(
      <MentionPopover
        open={true}
        query="bo"
        members={[mkCharacter({ id: "a", name: "Alice" }), mkCharacter({ id: "b", name: "Bob" })]}
        onPick={() => undefined}
        onDismiss={() => undefined}
      />
    )
    expect(screen.queryByText("Alice")).not.toBeInTheDocument()
    expect(screen.getByText("Bob")).toBeInTheDocument()
  })

  it("shows an empty hint when query matches nothing", () => {
    render(
      <MentionPopover
        open={true}
        query="zz"
        members={[mkCharacter({ id: "a", name: "Alice" })]}
        onPick={() => undefined}
        onDismiss={() => undefined}
      />
    )
    expect(screen.queryByText("Alice")).not.toBeInTheDocument()
    expect(screen.getByText(/no matches/i)).toBeInTheDocument()
  })

  it("calls onPick with the chosen character when a row is tapped", () => {
    const onPick = jest.fn()
    render(
      <MentionPopover
        open={true}
        query=""
        members={[mkCharacter({ id: "a", name: "Alice" })]}
        onPick={onPick}
        onDismiss={() => undefined}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: /alice/i }))
    expect(onPick).toHaveBeenCalledTimes(1)
    expect(onPick.mock.calls[0]![0].id).toBe("a")
  })

  it("calls onDismiss when the Sheet's escape-to-dismiss fires", () => {
    const onDismiss = jest.fn()
    render(
      <MentionPopover
        open={true}
        query=""
        members={[mkCharacter({ id: "a", name: "Alice" })]}
        onPick={() => undefined}
        onDismiss={onDismiss}
      />
    )
    // Radix Dialog (underlies Sheet) closes on Escape -> onOpenChange(false)
    // -> onDismiss(). This is the canonical dismiss path now that the
    // hand-rolled backdrop button has been replaced by SheetOverlay.
    fireEvent.keyDown(document.body, { key: "Escape", code: "Escape" })
    expect(onDismiss).toHaveBeenCalled()
  })

  it("floats above the measured composer height when provided", () => {
    render(
      <MentionPopover
        open={true}
        query=""
        members={[mkCharacter({ id: "a", name: "Alice" })]}
        composerHeight={150}
        onPick={() => undefined}
        onDismiss={() => undefined}
      />
    )
    const panel = screen.getByTestId("mobile-mention-popover-panel")
    expect(panel.style.bottom).toContain("150px")
  })

  it("falls back to ~5rem (80px) clearance when the composer is not yet measured", () => {
    render(
      <MentionPopover
        open={true}
        query=""
        members={[mkCharacter({ id: "a", name: "Alice" })]}
        composerHeight={0}
        onPick={() => undefined}
        onDismiss={() => undefined}
      />
    )
    const panel = screen.getByTestId("mobile-mention-popover-panel")
    expect(panel.style.bottom).toContain("80px")
  })

  it("ignores clicks inside the panel (no dismiss bubble-up)", () => {
    const onDismiss = jest.fn()
    render(
      <MentionPopover
        open={true}
        query=""
        members={[mkCharacter({ id: "a", name: "Alice" })]}
        onPick={() => undefined}
        onDismiss={onDismiss}
      />
    )
    fireEvent.click(screen.getByTestId("mobile-mention-popover-panel"))
    expect(onDismiss).not.toHaveBeenCalled()
  })
})
