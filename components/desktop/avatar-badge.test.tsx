/**
 * @jest-environment jsdom
 */
import { render } from "@testing-library/react"
import { AvatarBadge } from "./avatar-badge"

test("renders avatar glyph with emoji when provided", () => {
  const { container } = render(
    <AvatarBadge subject={{ name: "Code Reviewer", avatarEmoji: "🤖", avatarColor: "#ff0000" }} />
  )
  const span = container.querySelector("span") as HTMLSpanElement
  expect(span.textContent).toBe("🤖")
  expect(span.style.backgroundColor).toBe("rgb(255, 0, 0)")
  expect(span.style.color).toBe("white")
})

test("falls back to initials when emoji is absent", () => {
  const { container } = render(<AvatarBadge subject={{ name: "Alice Bob" }} />)
  expect(container.querySelector("span")?.textContent).toBe("AB")
})

test("uses deterministic color when avatarColor is missing", () => {
  const { container } = render(<AvatarBadge subject={{ name: "Repeatable" }} />)
  const a = container.querySelector("span") as HTMLSpanElement
  const { container: c2 } = render(<AvatarBadge subject={{ name: "Repeatable" }} />)
  const b = c2.querySelector("span") as HTMLSpanElement
  expect(a.style.backgroundColor).toBe(b.style.backgroundColor)
  expect(a.style.backgroundColor).not.toBe("")
})

test("respects size and textClassName overrides", () => {
  const { container } = render(
    <AvatarBadge subject={{ name: "X" }} size={32} textClassName="text-lg" />
  )
  const span = container.querySelector("span") as HTMLSpanElement
  expect(span.style.width).toBe("32px")
  expect(span.style.height).toBe("32px")
  expect(span.className).toContain("text-lg")
})

test("renders an inline status dot when provided", () => {
  const { container } = render(
    <AvatarBadge subject={{ name: "X" }} statusDot={<span data-testid="status" />} />
  )
  expect(container.querySelector("[data-testid='status']")).not.toBeNull()
})
