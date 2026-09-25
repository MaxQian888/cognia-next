import * as dexieHooks from "dexie-react-hooks"

import { useLiveQuery } from "./live-query"
import * as kit from "./index"

describe("useLiveQuery", () => {
  it("is the host's dexie-react-hooks hook, not a second copy", () => {
    expect(useLiveQuery).toBe(dexieHooks.useLiveQuery)
    expect(kit.useLiveQuery).toBe(dexieHooks.useLiveQuery)
  })
})
