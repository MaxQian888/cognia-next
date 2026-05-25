/**
 * @jest-environment jsdom
 */
import { fireEvent, render } from "@testing-library/react"
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

test("renders an image when avatarImageUrl is provided", () => {
  const { container } = render(
    <AvatarBadge
      subject={{ name: "Octo", avatarEmoji: "🐙", avatarImageUrl: "data:image/png;base64,AAA" }}
    />
  )
  const img = container.querySelector("img") as HTMLImageElement
  expect(img).not.toBeNull()
  expect(img.getAttribute("src")).toBe("data:image/png;base64,AAA")
  // Glyph is replaced by the image (no emoji text rendered).
  expect(container.querySelector("span")?.textContent).toBe("")
})

test("falls back to the glyph when the image fails to load", () => {
  const { container } = render(
    <AvatarBadge
      subject={{ name: "Octo", avatarEmoji: "🐙", avatarImageUrl: "data:image/png;base64,AAA" }}
    />
  )
  const img = container.querySelector("img") as HTMLImageElement
  fireEvent.error(img)
  expect(container.querySelector("img")).toBeNull()
  expect(container.querySelector("span")?.textContent).toBe("🐙")
})
