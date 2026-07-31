/**
 * @jest-environment node
 */

import { getDb } from "./schema"

describe("getDb server guard", () => {
  it("throws when called without a browser window", () => {
    expect(() => getDb()).toThrow(/called on the server/)
  })
})
