import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import messages from "@/i18n/messages/en.json"
import { NoticeItem, type NoticeItemProps, type NoticeSeverity } from "./notice-item"

// `NoticeItemProps` is a union — the dismiss handler and its label stand or
// fall together — so the overrides are spread through the union rather than a
// `Partial<>` of it, which would widen `onDismiss` back to optional-on-its-own.
type ItemOverrides = Partial<Omit<NoticeItemProps, "onDismiss" | "dismissLabel">> &
  ({ onDismiss: () => void; dismissLabel: string } | { onDismiss?: never; dismissLabel?: never })

function renderItem(props: ItemOverrides = {}) {
  const merged = {
    severity: "info" as NoticeSeverity,
    title: "Something happened",
    ...props,
  } as NoticeItemProps
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <NoticeItem {...merged} />
    </NextIntlClientProvider>
  )
}

/** The row element, whichever live-region role its severity earns it. */
function row(severity: NoticeSeverity = "info") {
  return screen.getByRole(severity === "info" ? "status" : "alert")
}

describe("NoticeItem", () => {
  it("renders the title in a live region", () => {
    renderItem()
    expect(row()).toHaveTextContent("Something happened")
  })

  // Up to five rows can open at once. A blanket assertive `alert` made a
  // screen reader talk over the user just to report ambient activity, so only
  // an actual problem interrupts.
  it.each<[NoticeSeverity, string]>([
    ["info", "status"],
    ["warning", "alert"],
    ["danger", "alert"],
  ])("announces %s severity as role=%s", (severity, role) => {
    renderItem({ severity })
    expect(screen.getByRole(role)).toHaveAttribute("data-severity", severity)
  })

  it("renders the detail body when given one", () => {
    renderItem({ children: <p>Detail line</p> })
    expect(screen.getByText("Detail line")).toBeInTheDocument()
  })

  it("renders trailing actions", () => {
    renderItem({ actions: <button type="button">Reconnect</button> })
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeInTheDocument()
  })

  it.each<[NoticeSeverity, string]>([
    ["info", "before:bg-info/60"],
    ["warning", "before:bg-warning/70"],
    ["danger", "before:bg-destructive/70"],
  ])("carries %s severity on the inline-start rail", (severity, rail) => {
    renderItem({ severity })
    const root = row(severity)
    expect(root).toHaveAttribute("data-severity", severity)
    expect(root).toHaveClass(rail)
  })

  // Reworked to logical properties alongside `conversation-row` and the search
  // input in the same round; physical left/right would mirror wrongly in RTL.
  it("positions the rail and padding with logical properties", () => {
    renderItem()
    const root = row()
    expect(root).toHaveClass("ps-3", "pe-2", "before:start-0")
    expect(root.className).not.toMatch(/\b(pl-\d|pr-\d|before:left-|before:right-)/)
  })

  // Replaces four full-bleed coloured bands; with five stacked, the
  // conversation opened behind a wall of colour.
  it("tints the rail and icon but never fills the row background", () => {
    renderItem({ severity: "danger" })
    const root = row("danger")
    expect(root).toHaveClass("text-foreground")
    // Only the `before:` rail may carry a background — no unprefixed fill.
    const unprefixedFill = root.className.split(/\s+/).filter((c) => c.startsWith("bg-"))
    expect(unprefixedFill).toEqual([])
  })

  // Severity must reach assistive tech, not just sighted users.
  it("states its severity in text, not colour alone", () => {
    renderItem({ severity: "warning" })
    expect(screen.getByText("Warning")).toHaveClass("sr-only")
  })

  it("accepts an icon override", () => {
    renderItem({ icon: <span data-testid="custom-icon" /> })
    expect(screen.getByTestId("custom-icon")).toBeInTheDocument()
  })

  it("omits the dismiss control unless a handler is supplied", () => {
    renderItem()
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
  })

  it("calls onDismiss from the labelled dismiss control", async () => {
    const onDismiss = jest.fn()
    renderItem({ onDismiss, dismissLabel: "Dismiss notice" })
    await userEvent.click(screen.getByRole("button", { name: "Dismiss notice" }))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it("forwards the test id and extra classes", () => {
    renderItem({ "data-testid": "my-notice", className: "custom-class" })
    const root = screen.getByTestId("my-notice")
    expect(root).toHaveClass("custom-class")
  })
})
