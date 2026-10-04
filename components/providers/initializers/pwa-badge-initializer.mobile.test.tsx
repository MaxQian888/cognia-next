import { readFileSync } from "node:fs"
import { join } from "node:path"
import { render } from "@testing-library/react"
import { PwaBadgeInitializer } from "./pwa-badge-initializer.mobile"

describe("PwaBadgeInitializer mobile compilation boundary", () => {
  it("mounts no desktop or browser lifecycle on Capacitor", () => {
    const { container } = render(<PwaBadgeInitializer />)
    expect(container).toBeEmptyDOMElement()
  })

  it("keeps non-mobile runtime dependencies outside the compilation graph", () => {
    const source = readFileSync(join(__dirname, "pwa-badge-initializer.mobile.tsx"), "utf8")
    expect(source).not.toMatch(/(?:^import |\bimport\(|\brequire\()/m)
  })
})
