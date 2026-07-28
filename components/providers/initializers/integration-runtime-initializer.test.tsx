import { render, waitFor } from "@testing-library/react"
import { detectPlatform } from "@/lib/platform/detect"
import { startIntegrationRuntime } from "@/lib/integrations/runtime"
import { IntegrationRuntimeInitializer } from "./integration-runtime-initializer"

jest.mock("@/lib/platform/detect", () => ({ detectPlatform: jest.fn() }))
jest.mock("@/lib/integrations/runtime", () => ({
  startIntegrationRuntime: jest.fn(),
}))

const mockedDetectPlatform = jest.mocked(detectPlatform)
const mockedStartRuntime = jest.mocked(startIntegrationRuntime)
const disposeRuntime = jest.fn()

beforeEach(() => {
  jest.clearAllMocks()
  mockedStartRuntime.mockResolvedValue(disposeRuntime)
})

it("does not execute platform actions in web or mobile clients", () => {
  mockedDetectPlatform.mockReturnValue("web")
  render(<IntegrationRuntimeInitializer />)
  expect(mockedStartRuntime).not.toHaveBeenCalled()
})

it("starts and disposes the shared runtime on the desktop host", async () => {
  mockedDetectPlatform.mockReturnValue("tauri")
  const { unmount } = render(<IntegrationRuntimeInitializer />)
  await waitFor(() => expect(mockedStartRuntime).toHaveBeenCalledTimes(1))
  unmount()
  expect(disposeRuntime).toHaveBeenCalledTimes(1)
})
