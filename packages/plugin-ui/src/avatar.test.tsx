import { render, screen } from "@testing-library/react"

import {
  Avatar,
  AvatarBadge,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
  AvatarImage,
} from "./avatar"

/**
 * `AvatarImage` mounts only once Radix's internal `new Image()` probe resolves,
 * and jsdom never fires `load` for a URL it did not fetch. So every assertion
 * here is about the fallback path and the wiring around it — which is also the
 * path a plugin hits most, since its avatar URLs are third-party and unreliable.
 */
describe("Avatar", () => {
  it("shows the caller's fallback while no image has loaded", () => {
    render(
      <Avatar>
        <AvatarImage src="https://example.invalid/ada.png" alt="Ada Lovelace" />
        <AvatarFallback>AL</AvatarFallback>
      </Avatar>
    )

    expect(screen.getByText("AL")).toHaveAttribute("data-slot", "avatar-fallback")
    // Nothing in the kit invents a label: the initials came from the plugin.
    expect(screen.queryByRole("img")).not.toBeInTheDocument()
  })

  it("defaults to the medium size and records it for descendants", () => {
    render(
      <Avatar>
        <AvatarFallback>AL</AvatarFallback>
      </Avatar>
    )

    const root = screen.getByText("AL").parentElement
    expect(root).toHaveAttribute("data-slot", "avatar")
    // The badge and group-count size themselves off this attribute, so it is
    // part of the contract rather than an implementation detail.
    expect(root).toHaveAttribute("data-size", "default")
    expect(root?.className).toContain("size-8")
  })

  it.each(["sm", "lg"] as const)("publishes the %s size to the cluster", (size) => {
    render(
      <Avatar size={size}>
        <AvatarFallback>AL</AvatarFallback>
      </Avatar>
    )

    expect(screen.getByText("AL").parentElement).toHaveAttribute("data-size", size)
  })

  it("merges a caller's sizing instead of stacking a second size utility", () => {
    render(
      <Avatar className="size-12">
        <AvatarFallback>AL</AvatarFallback>
      </Avatar>
    )

    const root = screen.getByText("AL").parentElement
    expect(root?.className).toContain("size-12")
    // cn() resolved size-8 against size-12 rather than emitting both.
    expect(root?.className).not.toContain("size-8")
  })

  it("forwards the fallback's delay so a fast image never flashes initials", () => {
    render(
      <Avatar>
        <AvatarFallback delayMs={600}>AL</AvatarFallback>
      </Avatar>
    )

    // Radix withholds the fallback for `delayMs`; nothing renders yet.
    expect(screen.queryByText("AL")).not.toBeInTheDocument()
  })

  it("renders a badge pinned inside the avatar", () => {
    render(
      <Avatar>
        <AvatarFallback>AL</AvatarFallback>
        <AvatarBadge aria-label="Online" role="status" />
      </Avatar>
    )

    const badge = screen.getByRole("status", { name: "Online" })
    expect(badge).toHaveAttribute("data-slot", "avatar-badge")
    // Meaning has to survive the `sm` size, where any icon inside is hidden —
    // hence the caller-supplied accessible name rather than a glyph alone.
    expect(badge.parentElement).toHaveAttribute("data-slot", "avatar")
  })

  it("stacks a group and its overflow count", () => {
    render(
      <AvatarGroup>
        <Avatar size="lg">
          <AvatarFallback>AL</AvatarFallback>
        </Avatar>
        <Avatar size="lg">
          <AvatarFallback>GH</AvatarFallback>
        </Avatar>
        <AvatarGroupCount>+3</AvatarGroupCount>
      </AvatarGroup>
    )

    const count = screen.getByText("+3")
    expect(count).toHaveAttribute("data-slot", "avatar-group-count")
    expect(count.parentElement).toHaveAttribute("data-slot", "avatar-group")
    // The count sizes off `group-has-data-[size=…]`, i.e. off its siblings, so
    // it cannot drift when the group's avatar size changes.
    expect(count.className).toContain("group-has-data-[size=lg]/avatar-group:size-10")
  })

  it("passes arbitrary DOM props through to each part", () => {
    render(
      <AvatarGroup data-testid="group" id="collaborators">
        <Avatar id="ada">
          <AvatarFallback id="ada-fallback">AL</AvatarFallback>
        </Avatar>
      </AvatarGroup>
    )

    expect(screen.getByText("AL")).toHaveAttribute("id", "ada-fallback")
    expect(document.getElementById("ada")).toHaveAttribute("data-slot", "avatar")
    expect(document.getElementById("collaborators")).toHaveAttribute("data-slot", "avatar-group")
  })
})
