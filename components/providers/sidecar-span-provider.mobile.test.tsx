import { readFileSync } from "node:fs"
import { join } from "node:path"
import { render } from "@testing-library/react"
import { SidecarSpanProvider } from "./sidecar-span-provider.mobile"

describe("SidecarSpanProvider mobile compilation boundary", () => {
  it("preserves children without adding a wrapper", () => {
    const { container } = render(
      <SidecarSpanProvider>
        <main>app</main>
      </SidecarSpanProvider>
    )
    expect(container.innerHTML).toBe("<main>app</main>")
  })

  it("keeps non-mobile runtime dependencies outside the compilation graph", () => {
    const source = readFileSync(join(__dirname, "sidecar-span-provider.mobile.tsx"), "utf8")
    expect(source).not.toMatch(/(?:^import |\bimport\(|\brequire\()/m)
  })
})
