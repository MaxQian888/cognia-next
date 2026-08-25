const getActiveRemoteEndpoint = jest.fn()
const hasWebCompanionTarget = jest.fn()
const isCapacitor = jest.fn()
const load = jest.fn()

jest.mock("@/lib/tauri/transport-routing", () => ({
  getActiveRemoteEndpoint: () => getActiveRemoteEndpoint(),
}))
jest.mock("@/lib/platform/web-companion", () => ({
  hasWebCompanionTarget: () => hasWebCompanionTarget(),
}))
jest.mock("@/lib/tauri", () => ({ isCapacitor: () => isCapacitor() }))
jest.mock("@/lib/tauri/companion-storage", () => ({
  pickCompanionStorage: () => ({ load }),
}))

import { defaultCompanionEndpointResolver } from "./companion-endpoint"

const REMOTE = { baseUrl: "https://host.example", deviceId: "d1" }
const PAIRED = { baseUrl: "https://paired.example", deviceId: "d2" }

beforeEach(() => {
  getActiveRemoteEndpoint.mockReset().mockReturnValue(null)
  hasWebCompanionTarget.mockReset().mockReturnValue(false)
  isCapacitor.mockReset().mockReturnValue(false)
  load.mockReset().mockResolvedValue(PAIRED)
})

// This is the bug the module exists for: a desktop driving a remote host keeps
// its identity in the remote-host store, not the companion cache, so a
// consumer that read only the cache resolved null and threw.
it("prefers an attached remote host, which is the desktop's only identity", async () => {
  getActiveRemoteEndpoint.mockReturnValue(REMOTE)
  await expect(defaultCompanionEndpointResolver()).resolves.toBe(REMOTE)
  expect(load).not.toHaveBeenCalled()
})

it("falls back to this shell's own pairing on the web", async () => {
  hasWebCompanionTarget.mockReturnValue(true)
  await expect(defaultCompanionEndpointResolver()).resolves.toBe(PAIRED)
})

it("falls back to the stored pairing on Capacitor", async () => {
  isCapacitor.mockReturnValue(true)
  await expect(defaultCompanionEndpointResolver()).resolves.toBe(PAIRED)
})

it("resolves nothing when no pairing is expected to exist", async () => {
  await expect(defaultCompanionEndpointResolver()).resolves.toBeNull()
  expect(load).not.toHaveBeenCalled()
})
