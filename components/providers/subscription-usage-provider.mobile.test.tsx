import { readFileSync } from "node:fs"
import { join } from "node:path"
import { render } from "@testing-library/react"
import { SubscriptionUsageProvider } from "./subscription-usage-provider.mobile"

describe("SubscriptionUsageProvider mobile compilation boundary", () => {
  it("preserves children without adding a wrapper", () => {
    const { container } = render(
      <SubscriptionUsageProvider>
        <main>app</main>
      </SubscriptionUsageProvider>
    )
    expect(container.innerHTML).toBe("<main>app</main>")
  })

  it("keeps non-mobile runtime dependencies outside the compilation graph", () => {
    const source = readFileSync(join(__dirname, "subscription-usage-provider.mobile.tsx"), "utf8")
    expect(source).not.toMatch(/(?:^import |\bimport\(|\brequire\()/m)
  })
})
