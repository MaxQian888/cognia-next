import { render } from "@testing-library/react"

const release = jest.fn()
const install = jest.fn(() => release)

jest.mock("@/lib/execution/install-execution-control", () => ({
  installExecutionControlPlane: () => install(),
}))

import { ExecutionControlInitializer } from "./execution-control-initializer"

beforeEach(() => jest.clearAllMocks())

it("renders nothing", () => {
  const { container } = render(<ExecutionControlInitializer />)
  expect(container).toBeEmptyDOMElement()
})

it("installs the control plane on mount", () => {
  render(<ExecutionControlInitializer />)
  expect(install).toHaveBeenCalledTimes(1)
})

it("releases its reference on unmount", () => {
  const { unmount } = render(<ExecutionControlInitializer />)
  expect(release).not.toHaveBeenCalled()
  unmount()
  expect(release).toHaveBeenCalledTimes(1)
})

it("does not reinstall on re-render", () => {
  const { rerender } = render(<ExecutionControlInitializer />)
  rerender(<ExecutionControlInitializer />)
  expect(install).toHaveBeenCalledTimes(1)
})
