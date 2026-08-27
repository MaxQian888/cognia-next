import { lucideRequireCompat } from "./lucide-require-compat"

describe("lucideRequireCompat", () => {
  it("resolves current and legacy named icon exports", () => {
    expect(lucideRequireCompat.Search).toBeDefined()
    expect(lucideRequireCompat.SearchIcon).toBe(lucideRequireCompat.Search)
    expect(lucideRequireCompat.CheckCircle2Icon).toBeDefined()
  })

  it("exposes the lightweight icons registry without inventing invalid names", () => {
    const icons = lucideRequireCompat.icons as Record<string, unknown>
    expect(icons.Search).toBeDefined()
    // `undefined`, like the real module's `icons` record — the shim stands in
    // for `lucide-react`, so a missing key answers the way that one does.
    expect(icons.NotARealLucideIcon).toBeUndefined()
    expect(lucideRequireCompat.NotARealLucideIcon).toBeUndefined()
  })
})
