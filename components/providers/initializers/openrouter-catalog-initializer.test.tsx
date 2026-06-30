import { StrictMode } from "react"
import { render } from "@testing-library/react"

const refreshMock = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/ai/providers/openrouter-catalog-sync", () => ({
  refreshOpenRouterCatalogIfStale: (...a: unknown[]) => refreshMock(...a),
}))

import { OpenRouterCatalogInitializer } from "./openrouter-catalog-initializer"

beforeEach(() => refreshMock.mockClear())

describe("OpenRouterCatalogInitializer", () => {
  it("kicks off a stale-refresh once on mount and renders nothing", () => {
    const { container, rerender } = render(<OpenRouterCatalogInitializer />)
    expect(container).toBeEmptyDOMElement()
    expect(refreshMock).toHaveBeenCalledTimes(1)
    // Re-render must not fire a second refresh (guarded by the ref).
    rerender(<OpenRouterCatalogInitializer />)
    expect(refreshMock).toHaveBeenCalledTimes(1)
  })

  it("the ref guard survives StrictMode's double-invoked effect", () => {
    // StrictMode mounts → runs effect → cleans up → runs effect again. The ref
    // guard must keep the refresh firing exactly once across that double-invoke.
    render(
      <StrictMode>
        <OpenRouterCatalogInitializer />
      </StrictMode>
    )
    expect(refreshMock).toHaveBeenCalledTimes(1)
  })
})
