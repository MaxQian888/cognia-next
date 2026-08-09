/**
 * @jest-environment jsdom
 */
let mockDbName: string | (() => never) = "cognia-account-acct_1"

jest.mock("@/lib/db/schema", () => ({
  getDb: () => {
    if (typeof mockDbName === "function") mockDbName()
    return { name: mockDbName }
  },
}))

import { DEFAULT_LOCAL_ACCOUNT_ID, getActiveAccountId } from "./active-account-id"

const originalEnv = process.env.COGNIA_LOCAL_ACCOUNT_ID

afterEach(() => {
  if (originalEnv === undefined) delete process.env.COGNIA_LOCAL_ACCOUNT_ID
  else process.env.COGNIA_LOCAL_ACCOUNT_ID = originalEnv
})

describe("getActiveAccountId", () => {
  it("reads the account out of the active database name", () => {
    mockDbName = "cognia-account-acct_1"
    expect(getActiveAccountId()).toBe("acct_1")
  })

  it("does not include the runtime target suffix in the account boundary", () => {
    mockDbName = "cognia-account-acct_1-target-headless_primary"
    expect(getActiveAccountId()).toBe("acct_1")
  })

  it("falls back to the default for a pre-multi-account database name", () => {
    mockDbName = "cognia"
    delete process.env.COGNIA_LOCAL_ACCOUNT_ID
    expect(getActiveAccountId()).toBe(DEFAULT_LOCAL_ACCOUNT_ID)
  })

  it("honours an explicit headless override", () => {
    mockDbName = "cognia"
    process.env.COGNIA_LOCAL_ACCOUNT_ID = "ci_account"
    expect(getActiveAccountId()).toBe("ci_account")
  })

  it("stays total when there is no database at all", () => {
    // SSR / static-export prerender: `getDb()` throws, and a persistence key
    // derivation must not become an exception because of it.
    mockDbName = () => {
      throw new Error("no indexeddb")
    }
    delete process.env.COGNIA_LOCAL_ACCOUNT_ID
    expect(getActiveAccountId()).toBe(DEFAULT_LOCAL_ACCOUNT_ID)
  })
})
