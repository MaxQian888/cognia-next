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
