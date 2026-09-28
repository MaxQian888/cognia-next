import type { Page } from "@playwright/test"
import { injectCapacitor } from "./inject-capacitor"

interface SecureStorage {
  set(input: { key: string; value: string }): Promise<unknown>
  get(input: { key: string }): Promise<{ value: string }>
  remove(input: { key: string }): Promise<unknown>
  clear(): Promise<unknown>
}

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow)
  else Reflect.deleteProperty(globalThis, "window")
})

async function fixture(persistSecureStorage: boolean) {
  const data = new Map<string, string>()
  const sessionStorage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value)
    },
  }
  let boot!: () => void
  const page = {
    addInitScript: async (callback: (arg: unknown) => void, arg: unknown) => {
      boot = () => callback(arg)
    },
  } as unknown as Page
  await injectCapacitor(page, { persistSecureStorage, secureStorage: { initial: "value" } })
  return () => {
    const next = { sessionStorage } as unknown as {
      sessionStorage: typeof sessionStorage
      Capacitor: { Plugins: { SecureStoragePlugin: SecureStorage } }
      __cogniaCapMock: { clearSecureStorage(): void }
    }
    Object.defineProperty(globalThis, "window", { configurable: true, value: next })
    boot()
    return { storage: next.Capacitor.Plugins.SecureStoragePlugin, mock: next.__cogniaCapMock }
  }
}

it("preserves paired synthetic credentials across documents when requested", async () => {
  const boot = await fixture(true)
  await boot().storage.set({ key: "paired-device", value: "synthetic-private-key" })
  await expect(boot().storage.get({ key: "paired-device" })).resolves.toEqual({
    value: "synthetic-private-key",
  })
})

it("keeps the existing fresh-document behavior by default", async () => {
  const boot = await fixture(false)
  await boot().storage.set({ key: "paired-device", value: "synthetic-private-key" })
  await expect(boot().storage.get({ key: "paired-device" })).rejects.toThrow("not found")
})

it("persists deletion and clearing without resurrecting initial credentials", async () => {
  const boot = await fixture(true)
  await boot().storage.remove({ key: "initial" })
  await expect(boot().storage.get({ key: "initial" })).rejects.toThrow("not found")
  await boot().storage.set({ key: "later", value: "value" })
  await boot().storage.clear()
  await expect(boot().storage.get({ key: "later" })).rejects.toThrow("not found")
  await boot().storage.set({ key: "last", value: "value" })
  boot().mock.clearSecureStorage()
  await expect(boot().storage.get({ key: "last" })).rejects.toThrow("not found")
})
