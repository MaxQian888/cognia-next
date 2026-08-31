/** @jest-environment jsdom */
import { render, waitFor } from "@testing-library/react"
import { migrateVectorCredentials } from "@cognia/vector/migrations/credential-migration"
import { VectorCredentialMigrationInitializer } from "./vector-credential-migration-initializer"

jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn(() => true) }))
const rehydrate = jest.fn().mockResolvedValue(undefined)
jest.mock("@/stores/vector/vector-store", () => ({
  useVectorStore: { persist: { rehydrate: (...args: unknown[]) => rehydrate(...args) } },
}))

jest.mock("@cognia/vector/migrations/credential-migration", () => ({
  migrateVectorCredentials: jest.fn(),
}))
const registerExistingTwinVectorBackend = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/db/twin-runtime-settings", () => ({
  registerExistingTwinVectorBackend: (...args: unknown[]) =>
    registerExistingTwinVectorBackend(...args),
}))

const migrate = migrateVectorCredentials as jest.MockedFunction<typeof migrateVectorCredentials>

beforeEach(() => {
  migrate.mockReset().mockResolvedValue({ ran: true, migrated: [] })
  rehydrate.mockClear()
  registerExistingTwinVectorBackend.mockClear()
})

it("runs the vector credential migration once when mounted", async () => {
  const { container, rerender } = render(<VectorCredentialMigrationInitializer />)
  expect(container).toBeEmptyDOMElement()
  await waitFor(() => expect(migrate).toHaveBeenCalledTimes(1))
  expect(rehydrate).toHaveBeenCalledTimes(1)
  expect(registerExistingTwinVectorBackend).toHaveBeenCalledTimes(1)

  rerender(<VectorCredentialMigrationInitializer />)
  expect(migrate).toHaveBeenCalledTimes(1)
})

it("contains migration failures so desktop boot can continue", async () => {
  migrate.mockRejectedValue(new Error("keyring unavailable"))
  expect(() => render(<VectorCredentialMigrationInitializer />)).not.toThrow()
  await waitFor(() => expect(migrate).toHaveBeenCalledTimes(1))
})

it("does not invoke the desktop keyring migration in the browser", async () => {
  const { isTauri } = jest.requireMock("@/lib/tauri") as { isTauri: jest.Mock }
  isTauri.mockReturnValueOnce(false)
  render(<VectorCredentialMigrationInitializer />)
  await waitFor(() => expect(migrate).not.toHaveBeenCalled())
})
