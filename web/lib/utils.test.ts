import { cn } from "@web/lib/utils"

describe("cn", () => {
  it("lets a later utility win over an earlier one in the same group", () => {
    expect(cn("px-5", "px-6")).toBe("px-6")
  })

  it("keeps responsive variants, which are a different group from the base", () => {
    // The override must not silently drop the `lg:` rule — every section in
    // this site is `px-5 lg:px-8`, so a merge that ate the breakpoint would
    // quietly collapse the desktop gutter.
    expect(cn("px-5 lg:px-8", "px-6")).toBe("lg:px-8 px-6")
  })

  it("drops a falsy conditional without leaving an empty class", () => {
    const active = false
    expect(cn("border-hairline", active && "border-action")).toBe("border-hairline")
  })

  it("merges the site's semantic colour tokens, because they match the standard scales", () => {
    // `border-<color>` / `text-<color>` / `bg-<color>` are shapes tailwind-merge
    // recognises, so the paper/ink tokens conflict-resolve for free.
    expect(cn("border-hairline", "border-action")).toBe("border-action")
    expect(cn("text-muted", "text-ink")).toBe("text-ink")
    expect(cn("bg-paper", "bg-surface")).toBe("bg-surface")
  })

  it("does NOT merge the site's custom radius scale — both classes survive", () => {
    // `--radius-control|panel|stage` are `@theme inline` additions whose names
    // are not in tailwind-merge's built-in radius group, so it cannot tell they
    // conflict. Pinned deliberately: this is a real sharp edge. Never write
    // `cn("rounded-panel", className)` expecting a caller's `rounded-stage` to
    // win — pick the radius at one place instead.
    expect(cn("rounded-control", "rounded-stage")).toBe("rounded-control rounded-stage")
  })
})
