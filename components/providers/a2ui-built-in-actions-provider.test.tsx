/** @jest-environment jsdom */
import { render } from "@testing-library/react"
import { A2UIBuiltInActionsProvider } from "./a2ui-built-in-actions-provider"
import { useA2UIAppBuilder } from "@/hooks/a2ui/use-app-builder"

jest.mock("@/hooks/a2ui/use-app-builder", () => ({
  useA2UIAppBuilder: jest.fn(() => ({})),
}))

describe("A2UIBuiltInActionsProvider", () => {
  beforeEach(() => jest.clearAllMocks())

  it("opts the builder into global built-in action handling", () => {
    render(<A2UIBuiltInActionsProvider />)
    expect(useA2UIAppBuilder).toHaveBeenCalledWith({ wireBuiltInActions: true })
  })

  it("renders nothing", () => {
    const { container } = render(<A2UIBuiltInActionsProvider />)
    expect(container).toBeEmptyDOMElement()
  })
})
