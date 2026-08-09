import { render, waitFor } from "@testing-library/react"

const setAdaptersMock = jest.fn()
const builtAdapters = { marker: "routing-deps" }
const certificationStore = { marker: "certification-store" }
const installDesktopCertificationRuntimeMock = jest.fn(async () => certificationStore)
const rebuildCompatibilityProjectionMock = jest.fn<Promise<number>, [unknown]>(async () => 1)
jest.mock("@cognia/provider-routing/runtime-adapters", () => ({
  setProviderRoutingRuntimeAdapters: (...a: unknown[]) => setAdaptersMock(...a),
}))
jest.mock("@/lib/claude/routing-runtime-deps", () => ({
  buildRoutingRuntimeAdapters: () => builtAdapters,
}))
jest.mock("@/lib/ai/agent/execution/certification-store", () => ({
  installDesktopCertificationRuntime: () => installDesktopCertificationRuntimeMock(),
}))
jest.mock("@/lib/db/agent-compatibility", () => ({
  rebuildCompatibilityProjection: (store: unknown) => rebuildCompatibilityProjectionMock(store),
}))

import { RoutingRuntimeInitializer } from "./routing-runtime-initializer"

beforeEach(() => {
  setAdaptersMock.mockClear()
  installDesktopCertificationRuntimeMock.mockClear()
  rebuildCompatibilityProjectionMock.mockClear()
})

describe("RoutingRuntimeInitializer", () => {
  it("installs routing and hydrates the certification projection once", async () => {
    const { container } = render(<RoutingRuntimeInitializer />)
    expect(container).toBeEmptyDOMElement()
    expect(setAdaptersMock).toHaveBeenCalledTimes(1)
    expect(setAdaptersMock).toHaveBeenCalledWith(builtAdapters)
    await waitFor(() => expect(installDesktopCertificationRuntimeMock).toHaveBeenCalledTimes(1))
    expect(rebuildCompatibilityProjectionMock).toHaveBeenCalledWith(certificationStore)
  })

  it("does not re-install on re-render (ref guard)", async () => {
    const { rerender } = render(<RoutingRuntimeInitializer />)
    rerender(<RoutingRuntimeInitializer />)
    expect(setAdaptersMock).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(installDesktopCertificationRuntimeMock).toHaveBeenCalledTimes(1))
  })
})
