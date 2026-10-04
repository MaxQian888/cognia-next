import { readFileSync } from "node:fs"
import { join } from "node:path"
import { render } from "@testing-library/react"
import { PwaLifecycleInitializer } from "./pwa-lifecycle-initializer.mobile"

describe("PwaLifecycleInitializer mobile compilation boundary", () => {
  it("mounts no desktop or browser lifecycle on Capacitor", () => {
    const { container } = render(<PwaLifecycleInitializer />)
    expect(container).toBeEmptyDOMElement()
  })

  it("keeps non-mobile runtime dependencies outside the compilation graph", () => {
    const source = readFileSync(join(__dirname, "pwa-lifecycle-initializer.mobile.tsx"), "utf8")
    expect(source).not.toMatch(/(?:^import |\bimport\(|\brequire\()/m)
  })
})
