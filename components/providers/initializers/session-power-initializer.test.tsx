import { readFileSync } from "node:fs"
import { join } from "node:path"

import { render } from "@testing-library/react"

const guard = jest.fn()
jest.mock("@/hooks/power/use-session-power-guard", () => ({
  useSessionPowerGuard: () => guard(),
}))

import { SessionPowerInitializer } from "./session-power-initializer"

describe("SessionPowerInitializer", () => {
  it("runs the coordinator and renders nothing", () => {
    const { container } = render(<SessionPowerInitializer />)
    expect(guard).toHaveBeenCalledTimes(1)
    expect(container).toBeEmptyDOMElement()
  })

  it("is mounted in the core-chat boot chunk", () => {
    // A coordinator that is never mounted is the repo's most common defect:
    // fully built, completely inert. Pinned against the source so a refactor
    // of the chunk cannot silently drop it.
    const source = readFileSync(
      join(process.cwd(), "components/providers/initializers/deferred-boot-initializers-impl.tsx"),
      "utf8"
    )
    expect(source).toContain("<SessionPowerInitializer />")
  })
})
