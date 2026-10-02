import { describe, expect, it } from "vitest"

import * as entry from "./index"

describe("Worker entrypoint", () => {
  it("exports only the handler object (the runtime rejects any other export)", () => {
    expect(Object.keys(entry)).toEqual(["default"])
    expect(typeof entry.default.fetch).toBe("function")
    expect(typeof entry.default.scheduled).toBe("function")
  })
})
