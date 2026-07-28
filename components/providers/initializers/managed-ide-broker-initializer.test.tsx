import { render } from "@testing-library/react"

jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn() }))
jest.mock("@/lib/plugin/ide/broker-runtime", () => ({
  attachManagedIdeBroker: jest.fn(),
}))

import { attachManagedIdeBroker } from "@/lib/plugin/ide/broker-runtime"
import { isTauri } from "@/lib/tauri"

import { ManagedIdeBrokerInitializer } from "./managed-ide-broker-initializer"

const mockedIsTauri = isTauri as jest.MockedFunction<typeof isTauri>
const mockedAttach = attachManagedIdeBroker as jest.MockedFunction<typeof attachManagedIdeBroker>

beforeEach(() => {
  jest.clearAllMocks()
})

it("attaches the managed broker once on desktop and cleans it up", async () => {
  const unlisten = jest.fn()
  mockedIsTauri.mockReturnValue(true)
  mockedAttach.mockResolvedValue(unlisten)
  const { unmount } = render(<ManagedIdeBrokerInitializer />)
  await Promise.resolve()
  expect(mockedAttach).toHaveBeenCalledTimes(1)
  unmount()
  expect(unlisten).toHaveBeenCalledTimes(1)
})

it("does not attach outside Tauri", () => {
  mockedIsTauri.mockReturnValue(false)
  render(<ManagedIdeBrokerInitializer />)
  expect(mockedAttach).not.toHaveBeenCalled()
})
