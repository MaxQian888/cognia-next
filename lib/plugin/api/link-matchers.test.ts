import { forwardRef, lazy, memo } from "react"
import {
  clearAllLinkMatchers,
  clearLinkMatchersForPlugin,
  getLinkMatcher,
  getLinkMatchersRevision,
  isLinkMatcherComponent,
  isValidLinkMatcherPattern,
  listLinkMatchers,
  registerLinkMatcher,
  subscribeLinkMatchers,
  validateLinkMatcherDefinition,
} from "./link-matchers"
import type { PluginLinkMatcherRegistrationDef } from "@/types/plugin/plugin-link-matcher"

const component = () => null
const def = (
  overrides: Partial<PluginLinkMatcherRegistrationDef> = {}
): PluginLinkMatcherRegistrationDef => ({
  id: "pull",
  patterns: ["github.com/**/pull/*"],
  component,
  ...overrides,
})
beforeEach(clearAllLinkMatchers)
afterEach(clearAllLinkMatchers)

it("orders by priority then plugin/id and selects only the first matching entry", () => {
  registerLinkMatcher("z", def({ priority: 2 }))
  registerLinkMatcher("a", def({ id: "z", priority: 2 }))
  registerLinkMatcher("a", def({ id: "a", priority: 2 }))
  registerLinkMatcher("top", def({ priority: 3, patterns: ["figma.com/**"] }))
  expect(listLinkMatchers().map(({ pluginId, id }) => `${pluginId}:${id}`)).toEqual([
    "top:pull",
    "a:a",
    "a:z",
    "z:pull",
  ])
  expect(getLinkMatcher("https://github.com/org/repo/pull/1")).toMatchObject({
    pluginId: "a",
    id: "a",
  })
})

it("isolates patterns from caller mutation and rejects duplicate ownership", () => {
  const definition = def()
  registerLinkMatcher("p", definition)
  definition.patterns[0] = "evil.com/**"
  definition.priority = 99
  expect(listLinkMatchers()[0]).toMatchObject({ patterns: ["github.com/**/pull/*"], priority: 0 })
  expect(() => registerLinkMatcher("p", def())).toThrow(/already registered/)
})

it("publishes revisions for mutations only, with idempotent disposal and purge", () => {
  const listener = jest.fn()
  const off = subscribeLinkMatchers(listener)
  const revision = getLinkMatchersRevision()
  const dispose = registerLinkMatcher("p", def())
  registerLinkMatcher("q", def())
  clearLinkMatchersForPlugin("missing")
  clearLinkMatchersForPlugin("p")
  const replacement = registerLinkMatcher("p", def())
  dispose()
  expect(listLinkMatchers()).toHaveLength(2)
  replacement()
  replacement()
  clearAllLinkMatchers()
  clearAllLinkMatchers()
  expect(listener).toHaveBeenCalledTimes(6)
  expect(getLinkMatchersRevision()).toBe(revision + 6)
  off()
  registerLinkMatcher("p", def())
  expect(listener).toHaveBeenCalledTimes(6)
})

it.each([
  ["github.com/**/pull/*", "https://GITHUB.com/org/repo/pull/1?tab=files#top", true],
  ["github.com/*", "http://github.com/foo", true],
  ["github.com/*", "https://github.com/foo/bar", false],
  ["github.com", "https://github.com/foo/bar", true],
  ["https://github.com/**", "http://github.com/foo", false],
  ["github.com/**", "https://github.com.evil.com/", false],
  ["github.com/**", "https://evilgithub.com/", false],
  ["github.com/**", "https://github.com@evil.com/", false],
  ["github.com/**", "https://evil.com@github.com/", false],
  ["github.com/**", "https://user:password@github.com/", false],
  ["github.com/**", "https://github.com:8443/", false],
  ["github.com:443/**", "https://github.com/", true],
  ["github.com:8080/**", "http://github.com:8080/", true],
  ["github.com:443/**", "http://github.com/", false],
  ["*.figma.com/*", "https://a.b.figma.com/file", true],
  ["*.figma.com/*", "https://figma.com/file", false],
  ["*.figma.com/*", "https://evilfigma.com/file", false],
  ["github.com/search?q=*#part", "https://github.com/search?q=repo#part", true],
  ["github.com/search?q=*#part", "https://github.com/search?q=repo#other", false],
  ["github.com/(test).md", "https://github.com/(test).md", true],
  ["github.com/(test).md", "https://github.com/testXmd", false],
  ["github.com/**", "/github.com/foo", false],
  ["github.com/**", "file:///github.com/foo", false],
  ["github.com/**", "javascript:alert(1)", false],
])("pattern %s matches %s = %s", (pattern, href, expected) => {
  registerLinkMatcher("p", def({ patterns: [pattern] }))
  expect(Boolean(getLinkMatcher(href))).toBe(expected)
})

it.each([
  null,
  "",
  "*",
  "**/**",
  "https://*/**",
  "javascript:foo",
  "file:///tmp/**",
  "git*hub.com/**",
  "https://github.com@evil.com/**",
  "a..com/**",
  "-a.com/**",
  "a-.com/**",
  "a.com:0/**",
  "a.com:65536/**",
  "a.com/***",
  "a.com/has space",
  "a.com/\\foo",
  "a.com\n/**",
  "a.com?x=*",
])("rejects malformed patterns %s", (pattern) => {
  expect(isValidLinkMatcherPattern(pattern)).toBe(false)
})

it("validates metadata and component types before mutation", () => {
  for (const invalid of [
    { id: "" },
    { id: "constructor" },
    { id: "prototype" },
    { id: "__proto__" },
    { id: "Upper" },
    { id: "a".repeat(129) },
    { id: "a-" },
    { patterns: [] },
    { patterns: null },
    { patterns: ["javascript:*"] },
    { priority: Infinity },
    { priority: "1" },
    { label: " " },
    { label: 1 },
    { component: null },
  ]) {
    expect(() =>
      registerLinkMatcher("p", { ...def(), ...invalid } as PluginLinkMatcherRegistrationDef)
    ).toThrow()
  }
  expect(() => validateLinkMatcherDefinition(null as never)).toThrow()
  expect(() => registerLinkMatcher("", def())).toThrow()
  expect(listLinkMatchers()).toEqual([])
  expect(getLinkMatcher("https://github.com/")).toBeUndefined()
  expect(isValidLinkMatcherPattern("github.com/**")).toBe(true)
})

it("accepts React component wrappers but not DOM tags, elements, or arbitrary objects", () => {
  expect(isLinkMatcherComponent(component)).toBe(true)
  expect(isLinkMatcherComponent(memo(component))).toBe(true)
  expect(isLinkMatcherComponent(forwardRef(component))).toBe(true)
  expect(isLinkMatcherComponent(lazy(async () => ({ default: component })))).toBe(true)
  for (const invalid of ["a", {}, null, { $$typeof: Symbol.for("react.element") }]) {
    expect(isLinkMatcherComponent(invalid)).toBe(false)
  }
})

it("handles many ambiguous wildcards without exponential regex backtracking", () => {
  registerLinkMatcher("p", def({ patterns: [`github.com/${"*a".repeat(30)}b`] }))
  expect(getLinkMatcher(`https://github.com/${"a".repeat(1000)}c`)).toBeUndefined()
  expect(getLinkMatcher(`https://github.com/${"a".repeat(1000)}b`)?.id).toBe("pull")
})
