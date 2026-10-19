import {
  clearActiveRuntimeTargetContext,
  setActiveRuntimeTargetContext,
} from "@/lib/runtime/runtime-target-context"
import { getSearchCache } from "@cognia/web-search/search-cache"
import { fetchCacheKey, getFetchCache } from "./fetch-cache"
import { currentWebScope, onWebScopeChange } from "./web-scope"

afterEach(() => {
  clearActiveRuntimeTargetContext()
  getFetchCache().clear()
  getSearchCache().clear()
})

it("falls back to local before any account is active", () => {
  expect(currentWebScope().split(":")[0]).toBe("local")
})

it("clears the departing fetch scope and search cache on account activation", () => {
  setActiveRuntimeTargetContext("acct_alpha", "local-host")
  const old = currentWebScope()
  const oldKey = fetchCacheKey({ url: "https://example.test/a", scope: old })
  const otherKey = fetchCacheKey({ url: "https://example.test/a", scope: "another-runtime" })
  getFetchCache().set(oldKey, "departing document")
  getFetchCache().set(otherKey, "other document")
  getSearchCache().set("query", {
    query: "query",
    provider: "tavily",
    results: [],
    responseTime: 0,
  })

  setActiveRuntimeTargetContext("acct_beta", "local-host")

  expect(currentWebScope()).not.toBe(old)
  expect(currentWebScope()).toContain("acct_beta")
  expect(getFetchCache().get(oldKey)).toBeNull()
  expect(getFetchCache().get(otherKey)).toBe("other document")
  expect(getSearchCache().get("query")).toBeNull()
})

it("changes scope on a host switch, lock and reactivation of the same account", () => {
  setActiveRuntimeTargetContext("acct_alpha", "local-host")
  const localHost = currentWebScope()
  setActiveRuntimeTargetContext("acct_alpha", "paired-host")
  const pairedHost = currentWebScope()
  expect(pairedHost).not.toBe(localHost)
  clearActiveRuntimeTargetContext()
  expect(currentWebScope()).not.toBe(pairedHost)
  setActiveRuntimeTargetContext("acct_alpha", "local-host")
  expect(currentWebScope()).not.toBe(localHost)
})

it("does not invalidate caches when the runtime identity is unchanged", () => {
  setActiveRuntimeTargetContext("acct_alpha", "local-host")
  const scope = currentWebScope()
  const key = fetchCacheKey({ url: "https://example.test/a", scope })
  getFetchCache().set(key, "document")
  onWebScopeChange()
  setActiveRuntimeTargetContext("acct_alpha", "local-host")
  expect(currentWebScope()).toBe(scope)
  expect(getFetchCache().get(key)).toBe("document")
})
