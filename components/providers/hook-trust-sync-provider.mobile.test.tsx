import { readFileSync } from "node:fs"
import { join } from "node:path"
import { render } from "@testing-library/react"
import { HookTrustSyncProvider } from "./hook-trust-sync-provider.mobile"

describe("HookTrustSyncProvider mobile compilation boundary", () => {
  it("preserves children without adding a wrapper", () => {
    const { container } = render(
      <HookTrustSyncProvider>
        <main>app</main>
      </HookTrustSyncProvider>
    )
    expect(container.innerHTML).toBe("<main>app</main>")
  })

  it("keeps non-mobile runtime dependencies outside the compilation graph", () => {
    const source = readFileSync(join(__dirname, "hook-trust-sync-provider.mobile.tsx"), "utf8")
    expect(source).not.toMatch(/(?:^import |\bimport\(|\brequire\()/m)
  })
})
