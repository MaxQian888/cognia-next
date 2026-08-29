/**
 * @jest-environment jsdom
 */

import { render } from "@testing-library/react"

const disposeCanvas = jest.fn()
const disposeArtifact = jest.fn()
const startCanvas = jest.fn(() => disposeCanvas)
const startArtifact = jest.fn(() => disposeArtifact)
const configureMonacoLoader = jest.fn()

jest.mock("@/lib/canvas/dexie-bridge", () => ({
  __esModule: true,
  startCanvasDexieBridge: () => startCanvas(),
}))
jest.mock("@/lib/artifacts/dexie-bridge", () => ({
  __esModule: true,
  startArtifactDexieBridge: () => startArtifact(),
}))
jest.mock("@/lib/canvas/monaco-loader", () => ({
  __esModule: true,
  configureMonacoLoader: () => configureMonacoLoader(),
}))

let accountRevision = 0
jest.mock("@/stores/account/account-store", () => ({
  __esModule: true,
  useAccountStore: (selector: (state: { accountRevision: number }) => unknown) =>
    selector({ accountRevision }),
}))

import { CanvasBridgeProvider } from "./canvas-bridge-provider"

beforeEach(() => {
  accountRevision = 0
  jest.clearAllMocks()
})

describe("CanvasBridgeProvider", () => {
  it("starts both bridges and configures Monaco on mount", () => {
    render(
      <CanvasBridgeProvider>
        <span>child</span>
      </CanvasBridgeProvider>
    )

    expect(configureMonacoLoader).toHaveBeenCalledTimes(1)
    expect(startCanvas).toHaveBeenCalledTimes(1)
    expect(startArtifact).toHaveBeenCalledTimes(1)
  })

  it("renders its children", () => {
    const { getByText } = render(
      <CanvasBridgeProvider>
        <span>child</span>
      </CanvasBridgeProvider>
    )
    expect(getByText("child")).toBeInTheDocument()
  })

  it("restarts the artifact bridge when the account changes", () => {
    // Each account has its own Dexie database. A bridge that kept mirroring
    // across a switch would write one account's artifacts into another's, and
    // only a restart re-runs hydration against the database selected now.
    const { rerender } = render(
      <CanvasBridgeProvider>
        <span>child</span>
      </CanvasBridgeProvider>
    )
    expect(startArtifact).toHaveBeenCalledTimes(1)

    accountRevision = 1
    rerender(
      <CanvasBridgeProvider>
        <span>child</span>
      </CanvasBridgeProvider>
    )

    expect(disposeArtifact).toHaveBeenCalledTimes(1)
    expect(startArtifact).toHaveBeenCalledTimes(2)
  })

  it("leaves the canvas bridge alone across an account change", () => {
    // Canvas documents are still written to localStorage as well, so the
    // canvas mirror has a safety net the artifact one does not — restarting it
    // here would re-run its hydration for no benefit.
    const { rerender } = render(
      <CanvasBridgeProvider>
        <span>child</span>
      </CanvasBridgeProvider>
    )

    accountRevision = 2
    rerender(
      <CanvasBridgeProvider>
        <span>child</span>
      </CanvasBridgeProvider>
    )

    expect(startCanvas).toHaveBeenCalledTimes(1)
    expect(disposeCanvas).not.toHaveBeenCalled()
  })

  it("disposes both bridges on unmount", () => {
    const { unmount } = render(
      <CanvasBridgeProvider>
        <span>child</span>
      </CanvasBridgeProvider>
    )
    unmount()

    expect(disposeCanvas).toHaveBeenCalledTimes(1)
    expect(disposeArtifact).toHaveBeenCalledTimes(1)
  })
})
