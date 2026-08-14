import { render } from "@testing-library/react"

jest.mock("@/lib/plugin/devtools/developer-mode", () => ({
  migrateDeveloperMode: jest.fn(() => false),
}))

import { DeveloperModeInitializer } from "./developer-mode-initializer"
import { migrateDeveloperMode } from "@/lib/plugin/devtools/developer-mode"

const migrate = migrateDeveloperMode as jest.Mock

beforeEach(() => {
  migrate.mockClear()
})

describe("DeveloperModeInitializer", () => {
  it("runs the migration once on mount", () => {
    render(<DeveloperModeInitializer />)
    expect(migrate).toHaveBeenCalledTimes(1)
  })

  it("renders nothing", () => {
    const { container } = render(<DeveloperModeInitializer />)
    expect(container).toBeEmptyDOMElement()
  })

  it("does not re-run on re-render", () => {
    const { rerender } = render(<DeveloperModeInitializer />)
    rerender(<DeveloperModeInitializer />)
    expect(migrate).toHaveBeenCalledTimes(1)
  })
})
