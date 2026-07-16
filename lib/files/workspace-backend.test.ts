jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn() }))
jest.mock("@/lib/tauri/transport-companion", () => ({ loadCompanionConfig: jest.fn() }))

import { isTauri } from "@/lib/tauri"
import { loadCompanionConfig } from "@/lib/tauri/transport-companion"
import { hasWorkspaceFsBackend } from "./workspace-backend"

const isTauriMock = isTauri as jest.Mock
const loadCompanionConfigMock = loadCompanionConfig as jest.Mock

describe("hasWorkspaceFsBackend", () => {
  beforeEach(() => {
    isTauriMock.mockReturnValue(false)
    loadCompanionConfigMock.mockReturnValue(null)
  })

  it("is available in Tauri", () => {
    isTauriMock.mockReturnValue(true)
    expect(hasWorkspaceFsBackend()).toBe(true)
  })

  it("is available to a paired browser", () => {
    loadCompanionConfigMock.mockReturnValue({ baseUrl: "https://desktop.test" })
    expect(hasWorkspaceFsBackend()).toBe(true)
  })

  it("is unavailable to an unpaired browser", () => {
    expect(hasWorkspaceFsBackend()).toBe(false)
  })
})
