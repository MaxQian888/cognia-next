import * as dexieHooks from "dexie-react-hooks"

import { useLiveQuery } from "./live-query"
import * as kit from "./index"

describe("useLiveQuery", () => {
  it("is the host's dexie-react-hooks hook, not a second copy", () => {
    const hook: typeof dexieHooks.useLiveQuery = useLiveQuery
    expect(hook).toBe(dexieHooks.useLiveQuery)
    expect(kit.useLiveQuery).toBe(dexieHooks.useLiveQuery)
  })
})

test("retains synchronous, asynchronous and default-result overloads", () => {
  const synchronous: (query: () => number, deps?: unknown[]) => number | undefined = useLiveQuery
  const asynchronous: (query: () => Promise<string>, deps?: unknown[]) => string | undefined =
    useLiveQuery
  const withNullDefault: (query: () => number, deps: unknown[], fallback: null) => number | null =
    useLiveQuery
  const withDifferentDefault: (
    query: () => Promise<number>,
    deps: unknown[],
    fallback: string
  ) => number | string = useLiveQuery
  for (const hook of [synchronous, asynchronous, withNullDefault, withDifferentDefault]) {
    expect(hook).toBe(dexieHooks.useLiveQuery)
  }
})
