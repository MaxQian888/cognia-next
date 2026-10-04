import { readFileSync } from "node:fs"
import { join } from "node:path"
import { render } from "@testing-library/react"
import { WindowLivenessInitializers } from "./window-liveness-initializers.mobile"

describe("WindowLivenessInitializers mobile compilation boundary", () => {
  it("mounts no desktop or browser lifecycle on Capacitor", () => {
    const { container } = render(<WindowLivenessInitializers />)
    expect(container).toBeEmptyDOMElement()
  })

  it("keeps non-mobile runtime dependencies outside the compilation graph", () => {
    const source = readFileSync(join(__dirname, "window-liveness-initializers.mobile.tsx"), "utf8")
    expect(source).not.toMatch(/(?:^import |\bimport\(|\brequire\()/m)
  })
})
