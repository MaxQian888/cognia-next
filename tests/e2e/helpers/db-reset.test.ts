import { IDBFactory } from "fake-indexeddb"
import type { Page } from "@playwright/test"
import {
  bootstrapCogniaMobile,
  ensureAppMounted,
  ensureCogniaAccount,
  resetCogniaDb,
} from "./db-reset"

jest.mock("@playwright/test", () => ({
  expect: Object.assign((actual: unknown) => expect(actual), {
    poll: (read: () => Promise<unknown>) => ({
      toBe: async (expected: unknown) => {
        let result: unknown
        for (let attempt = 0; attempt < 3; attempt += 1) {
          result = await read()
          if (result === expected) return
        }
        expect(result).toBe(expected)
      },
    }),
  }),
}))

const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document")
const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB")

function createPage({
  ready = false,
  native = false,
  existingAccount = false,
  blocked = false,
} = {}) {
  const reset = jest.fn(async () => {})
  const setSettings = jest.fn(async () => {})
  const fixtureWindow = {
    __cogniaResetDb: reset,
    __cogniaSetSettings: setSettings,
    __cogniaTestGlobalsReady: true,
    __cogniaPluginRuntimeReady: ready,
    ...(native ? { __TAURI_INTERNALS__: {} } : {}),
  }
  Object.defineProperty(globalThis, "window", { configurable: true, value: fixtureWindow })
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: {
      databases: async () => (existingAccount ? [{ name: "cognia-account-registry" }] : []),
    },
  })
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { querySelector: () => (blocked ? {} : null) },
  })
  let currentUrl = "http://localhost:3000/workflows"
  let seeded = false
  const goto = jest.fn(async (url: string) => {
    currentUrl = url
    if (url !== "about:blank" && seeded) fixtureWindow.__cogniaPluginRuntimeReady = true
  })
  const waitForFunction = jest.fn(
    async (
      callback: (argument?: Record<string, unknown>) => unknown,
      argument?: Record<string, unknown>,
      options?: { timeout: number }
    ) => {
      if (options?.timeout === 45_000 && existingAccount && !blocked)
        fixtureWindow.__cogniaPluginRuntimeReady = true
      if (argument?.databaseName === "cognia-account-registry") {
        seeded = true
        return { jsonValue: async () => true }
      }
      const value = await callback(argument)
      if (!value) throw new Error("Account runtime has not settled")
      return { jsonValue: async () => value }
    }
  )
  const reload = jest.fn(async () => {
    blocked = false
    fixtureWindow.__cogniaPluginRuntimeReady = true
  })
  const waitForAccountForm = jest.fn(async () => {})
  const getByRole = jest.fn(() => ({ waitFor: waitForAccountForm }))
  const getByTestId = jest.fn(() => ({ click: reload }))
  const page = {
    getByTestId,
    getByRole,
    waitForLoadState: jest.fn(async () => {}),
    url: () => currentUrl,
    goto,
    evaluate: jest.fn(
      async (
        callback: (argument?: Record<string, unknown>) => unknown,
        argument?: Record<string, unknown>
      ) => {
        if (argument?.databaseName === "cognia-account-registry") {
          seeded = true
          return true
        }
        return argument?.table === "accounts" ? [{ id: "existing-profile" }] : callback(argument)
      }
    ),
    waitForFunction,
  } as unknown as Page
  return {
    page,
    goto,
    waitForFunction,
    reset,
    setSettings,
    getByTestId,
    reload,
    getByRole,
    waitForAccountForm,
  }
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "window")
  if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument)
  else Reflect.deleteProperty(globalThis, "document")
  if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB)
  else Reflect.deleteProperty(globalThis, "indexedDB")
})

test("an early bridge above AccountGate cannot bypass account seeding and unlock readiness", async () => {
  const { page, goto, waitForFunction } = createPage()
  await ensureAppMounted(page)
  expect(page.evaluate).toHaveBeenCalledWith(expect.any(Function), {
    accountId: "acct_e2e_seed_account",
    databaseName: "cognia-account-registry",
  })
  expect(goto.mock.calls.map(([url]) => url)).toEqual([
    "about:blank",
    "http://localhost:3000/workflows",
  ])
  expect(waitForFunction).toHaveBeenLastCalledWith(expect.any(Function), true, {
    timeout: 45_000,
  })
})

test("an already unlocked runtime keeps its account and document", async () => {
  const { page, goto, waitForFunction } = createPage({ ready: true })
  await ensureAppMounted(page)
  expect(goto).not.toHaveBeenCalled()
  expect(waitForFunction).toHaveBeenCalledTimes(1)
})

test("ordinary feature resets establish completed onboarding without choosing mobile runtime mode", async () => {
  const { page, reset, setSettings } = createPage({ ready: true })
  await resetCogniaDb(page)
  expect(reset).toHaveBeenCalledTimes(1)
  expect(setSettings).toHaveBeenCalledWith({
    onboardingProgress: {
      version: 2,
      path: "completed",
      completedAt: "2026-09-28T00:00:00.000Z",
    },
  })
})

test("onboarding coverage requests a fresh reset without injecting completed progress", async () => {
  const { page, reset, setSettings } = createPage({ ready: true })
  await resetCogniaDb(page, { onboarding: "fresh" })
  expect(reset).toHaveBeenCalledTimes(1)
  expect(setSettings).not.toHaveBeenCalled()
})

test("native unlocked fixtures retain their authenticated account", async () => {
  const { page, goto } = createPage({ native: true, ready: true })
  await resetCogniaDb(page, { onboarding: "fresh" })
  expect(goto).not.toHaveBeenCalled()
})

test("native pending boot never seeds a browser verifier over the real account", async () => {
  const { page, goto, waitForFunction, reset } = createPage({ native: true })
  await expect(resetCogniaDb(page)).rejects.toThrow("Account runtime has not settled")
  expect(goto).not.toHaveBeenCalled()
  expect(reset).not.toHaveBeenCalled()
  expect(waitForFunction.mock.calls.some(([, arg]) => arg?.databaseName)).toBe(false)
})

test("an existing browser account finishes provisioning without reseeding or navigation", async () => {
  const { page, goto, waitForFunction } = createPage({ existingAccount: true })
  await ensureAppMounted(page)
  expect(goto).not.toHaveBeenCalled()
  expect(waitForFunction.mock.calls.some(([, arg]) => arg?.databaseName)).toBe(false)
  expect(waitForFunction).toHaveBeenLastCalledWith(expect.any(Function), true, {
    timeout: 45_000,
  })
})

test("account readiness retains the prescribed blocked-schema recovery", async () => {
  const { page, goto, getByTestId, reload } = createPage({ existingAccount: true, blocked: true })
  await ensureAppMounted(page)
  expect(getByTestId).toHaveBeenCalledWith("db-upgrade-blocked-reload")
  expect(reload).toHaveBeenCalledTimes(1)
  expect(goto).not.toHaveBeenCalled()
})

test("fresh seeding waits for the initial account load before changing its registry", async () => {
  const { page, getByRole, waitForAccountForm, waitForFunction } = createPage()
  await ensureAppMounted(page)
  expect(getByRole).toHaveBeenCalledWith("form", { name: "Create local account", exact: true })
  expect(waitForAccountForm).toHaveBeenCalledWith({ state: "visible", timeout: 30_000 })
  expect(waitForAccountForm.mock.invocationCallOrder[0]).toBeLessThan(
    waitForFunction.mock.invocationCallOrder[0]
  )
})

test("account seeding retries a resolved false result until its transaction commits", async () => {
  const { page, waitForFunction } = createPage()
  jest.mocked(page.evaluate).mockResolvedValueOnce(false).mockResolvedValueOnce(true)
  await expect(ensureCogniaAccount(page)).resolves.toBe("acct_e2e_seed_account")
  expect(page.evaluate).toHaveBeenCalledTimes(2)
  expect(waitForFunction).not.toHaveBeenCalled()
})

test("mobile bootstrap seeds its prepared account without modifying an earlier legacy database", async () => {
  const { page } = createPage()
  const install = jest.fn()
  Object.assign(page, { addInitScript: install, waitForFunction: jest.fn(async () => {}) })
  await bootstrapCogniaMobile(page, "standalone", { onboardingProgress: { path: "completed" } })
  const databaseFactory = new IDBFactory()
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: databaseFactory })
  const open = (name: string) =>
    new Promise<IDBDatabase>((resolve) => {
      const request = databaseFactory.open(name, 1)
      request.onupgradeneeded = () =>
        request.result.createObjectStore("settings", { keyPath: "id" })
      request.onsuccess = () => resolve(request.result)
    })
  const legacy = await open("cognia-claude")
  const account = await open("cognia-account-acct_e2e_seed_account-encrypted-v1")
  const sessionValues = new Map<string, string>()
  Object.assign(window, {
    sessionStorage: {
      getItem: (key: string) => sessionValues.get(key) ?? null,
      setItem: (key: string, value: string) => sessionValues.set(key, value),
    },
  })
  const [initialize, argument] = install.mock.calls[0]
  initialize(argument)
  const read = (database: IDBDatabase) =>
    new Promise<Record<string, unknown> | undefined>((resolve) => {
      const request = database.transaction("settings").objectStore("settings").get("singleton")
      request.onsuccess = () => resolve(request.result)
    })
  let seeded: Record<string, unknown> | undefined
  for (let attempt = 0; attempt < 10 && !seeded; attempt += 1) seeded = await read(account)
  expect(seeded).toMatchObject({
    mobileRuntimeMode: "standalone",
    onboardingProgress: { path: "completed" },
  })
  expect(await read(legacy)).toBeUndefined()
  legacy.close()
  account.close()
})
