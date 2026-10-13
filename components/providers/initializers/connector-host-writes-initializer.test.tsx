/** @jest-environment jsdom */
import { render, waitFor } from "@testing-library/react"

const restore = jest.fn()
const install = jest.fn((_writer: unknown) => restore)
const writer = { applies: () => true }
jest.mock("@/lib/db/adapter-instance-remote-writer", () => ({
  setAdapterInstanceRemoteWriter: (w: unknown) => install(w),
}))
jest.mock("@/lib/connectors/host-instance-writer", () => ({
  createHostAdapterInstanceWriter: () => writer,
}))

import { ConnectorHostWritesInitializer } from "./connector-host-writes-initializer"

beforeEach(() => jest.clearAllMocks())

it("installs the Host writer and restores the previous one on unmount", async () => {
  const { unmount } = render(<ConnectorHostWritesInitializer />)
  await waitFor(() => expect(install).toHaveBeenCalledWith(writer))
  unmount()
  expect(restore).toHaveBeenCalledTimes(1)
})

it("installs nothing once unmounted before the modules load", async () => {
  const { unmount } = render(<ConnectorHostWritesInitializer />)
  unmount()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(install).not.toHaveBeenCalled()
})
