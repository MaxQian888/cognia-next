/**
 * @jest-environment node
 */

import { __enableDbRuntimeForTesting, getDb } from "./schema"

describe("getDb server guard", () => {
  it("throws when called without a browser window", () => {
    expect(() => getDb()).toThrow(/called on the server/)
  })

  it("requires fake IndexedDB before enabling the explicit test runtime", () => {
    expect(() => __enableDbRuntimeForTesting()).toThrow(/requires an IndexedDB implementation/)
  })

  it("never enables the test runtime outside NODE_ENV=test", () => {
    const mutableEnv = process.env as Record<string, string | undefined>
    const previous = mutableEnv.NODE_ENV
    mutableEnv.NODE_ENV = "production"
    try {
      expect(() => __enableDbRuntimeForTesting()).toThrow(/only available when NODE_ENV=test/)
    } finally {
      if (previous === undefined) {
        delete mutableEnv.NODE_ENV
      } else {
        mutableEnv.NODE_ENV = previous
      }
    }
  })
})
