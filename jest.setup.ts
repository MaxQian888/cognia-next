/**
 * Jest setup file
 * This file is executed before each test file
 */

import "@testing-library/jest-dom"
import React from "react"

// jsdom omits `window.matchMedia` — provide a default (non-matching) stub so
// viewport hooks (`hooks/ui/use-mobile.ts:useIsMobile`, the shadcn sidebar,
// the goal detail sheet's responsive Sheet/Drawer switch) render their
// desktop branch in tests instead of throwing. Tests that need the mobile
// branch override `useIsMobile` directly.
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  })
}

// jsdom omits TextEncoder/TextDecoder — node:util has them. Required by
// crypto helpers and fake-indexeddb's structured clone.
if (typeof globalThis.TextEncoder === "undefined") {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { TextEncoder, TextDecoder } = require("node:util")
  Object.assign(globalThis, { TextEncoder, TextDecoder })
}

// jsdom omits Web Crypto's `subtle` API; Node's `node:crypto` has the same
// shape under `webcrypto.subtle`. Wire it up so `crypto.subtle.digest()` and
// the rest of the WebCrypto surface work inside tests (used by the twin
// source uploader's SHA-256 fingerprinter and a few other paths).
//
// We wrap webcrypto in a plain object so `crypto.subtle = …` style mocks in
// individual tests (`lib/skills/sync.test.ts`) still work. The native
// `Crypto` interface exposes `subtle` as a read-only getter; copying the
// fields onto a plain object preserves call behaviour while letting tests
// reassign the property.
if (typeof globalThis.crypto === "undefined" || !globalThis.crypto.subtle) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { webcrypto } = require("node:crypto")
  const mutableCrypto: {
    subtle: typeof webcrypto.subtle
    getRandomValues: typeof webcrypto.getRandomValues
    randomUUID: typeof webcrypto.randomUUID
  } = {
    subtle: webcrypto.subtle,
    getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
    randomUUID: webcrypto.randomUUID.bind(webcrypto),
  }
  Object.defineProperty(globalThis, "crypto", {
    value: mutableCrypto,
    configurable: true,
    writable: true,
  })
}

// jsdom omits the WHATWG Streams globals (TransformStream / ReadableStream /
// WritableStream). Several ported HTTP clients (undici under
// `@qdrant/js-client-rest`, `pdfjs-dist` workers, the AI SDK) construct these
// at module init, so a missing global crashes the test runtime before a
// single assertion runs. Pull from `web-streams-polyfill/polyfill` (which is
// CJS and side-effect installs the globals) — guarded so we don't double-
// install when running under Node 18+ where the natives may be present.
if (typeof globalThis.TransformStream === "undefined") {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const polyfill = require("web-streams-polyfill/polyfill")
  // The polyfill exports the constructors as named exports; guard for both
  // shapes (ESM default + CJS named) for forward compatibility.
  const ReadableStreamCtor = polyfill.ReadableStream ?? polyfill.default?.ReadableStream
  const WritableStreamCtor = polyfill.WritableStream ?? polyfill.default?.WritableStream
  const TransformStreamCtor = polyfill.TransformStream ?? polyfill.default?.TransformStream
  if (TransformStreamCtor) {
    Object.assign(globalThis, {
      ReadableStream: ReadableStreamCtor,
      WritableStream: WritableStreamCtor,
      TransformStream: TransformStreamCtor,
    })
  }
}

// jsdom omits ResizeObserver / IntersectionObserver — Radix primitives use them
// (Sheet, Slider, etc.). Provide a minimal polyfill so component tests can mount.
class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

if (typeof globalThis.ResizeObserver === "undefined") {
  ;(globalThis as unknown as { ResizeObserver: typeof MockResizeObserver }).ResizeObserver =
    MockResizeObserver
}
if (
  typeof window !== "undefined" &&
  typeof (window as unknown as { ResizeObserver?: unknown }).ResizeObserver === "undefined"
) {
  ;(window as unknown as { ResizeObserver: typeof MockResizeObserver }).ResizeObserver =
    MockResizeObserver
}

class MockIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [] as unknown[]
  }
  root = null
  rootMargin = ""
  thresholds: number[] = []
}

if (typeof globalThis.IntersectionObserver === "undefined") {
  ;(
    globalThis as unknown as { IntersectionObserver: typeof MockIntersectionObserver }
  ).IntersectionObserver = MockIntersectionObserver
}
if (
  typeof window !== "undefined" &&
  typeof (window as unknown as { IntersectionObserver?: unknown }).IntersectionObserver ===
    "undefined"
) {
  ;(
    window as unknown as { IntersectionObserver: typeof MockIntersectionObserver }
  ).IntersectionObserver = MockIntersectionObserver
}

// Radix primitives sometimes call hasPointerCapture / scrollIntoView, neither
// of which jsdom implements. Stub them to satisfy callers.
if (typeof Element !== "undefined") {
  if (typeof Element.prototype.hasPointerCapture !== "function") {
    Element.prototype.hasPointerCapture = function () {
      return false
    }
  }
  if (typeof Element.prototype.releasePointerCapture !== "function") {
    Element.prototype.releasePointerCapture = function () {}
  }
  if (typeof Element.prototype.scrollIntoView !== "function") {
    Element.prototype.scrollIntoView = function () {}
  }
}

// jsdom omits the WHATWG `Response` constructor (jest-environment-jsdom v30
// masks it). Provide a minimal stand-in tailored to the shape `cloudFetch`
// reads — status, ok, text(), headers — so OCR provider tests that mock
// `fetch` with `new Response(...)` work.
if (typeof (globalThis as { Response?: unknown }).Response === "undefined") {
  class MinimalResponse {
    readonly status: number
    readonly statusText: string
    readonly ok: boolean
    readonly headers: Headers
    private _body: string

    constructor(
      body: string | Uint8Array | undefined,
      init: { status?: number; statusText?: string; headers?: Record<string, string> } = {}
    ) {
      this.status = init.status ?? 200
      this.statusText = init.statusText ?? ""
      this.ok = this.status >= 200 && this.status < 300
      this.headers = new Headers(init.headers)
      this._body =
        body === undefined ? "" : typeof body === "string" ? body : new TextDecoder().decode(body)
    }

    async text(): Promise<string> {
      return this._body
    }
    async json(): Promise<unknown> {
      return JSON.parse(this._body) as unknown
    }
  }
  ;(globalThis as unknown as { Response: typeof MinimalResponse }).Response = MinimalResponse
}

// jsdom doesn't expose structuredClone, but Node.js 17+ has it on the global
// scope. Make it visible to jsdom-environment tests so fake-indexeddb (which
// clones values for insertion) works inside the IndexedDB transport tests.
if (typeof (globalThis as { structuredClone?: unknown }).structuredClone !== "function") {
  const nodeStructuredClone = (globalThis as { structuredClone?: unknown }).structuredClone
  if (typeof nodeStructuredClone !== "function") {
    // Node 17+ exposes structuredClone globally; if older, fall back to a
    // JSON-based clone which is good enough for the log entries we test.
    ;(globalThis as { structuredClone: (v: unknown) => unknown }).structuredClone = (
      value: unknown
    ) => JSON.parse(JSON.stringify(value)) as unknown
  }
}
// Mirror onto window when running under jsdom so libraries that read
// `window.structuredClone` see it.
if (
  typeof window !== "undefined" &&
  typeof (window as { structuredClone?: unknown }).structuredClone !== "function"
) {
  ;(window as unknown as { structuredClone: typeof structuredClone }).structuredClone = (
    globalThis as { structuredClone: typeof structuredClone }
  ).structuredClone
}

type MockNextImageProps = React.ComponentPropsWithoutRef<"img"> & {
  priority?: boolean
  fill?: boolean
}

// Mock Next.js Image component
jest.mock("next/image", () => ({
  __esModule: true,
  default: (props: MockNextImageProps) => {
    const normalizedProps = { ...props }
    delete normalizedProps.priority
    delete normalizedProps.fill
    return React.createElement("img", normalizedProps)
  },
}))

// Mock Next.js router
jest.mock("next/navigation", () => ({
  useRouter() {
    return {
      push: jest.fn(),
      replace: jest.fn(),
      prefetch: jest.fn(),
      back: jest.fn(),
      pathname: "/",
      query: {},
      asPath: "/",
    }
  },
  usePathname() {
    return "/"
  },
  useSearchParams() {
    return new URLSearchParams()
  },
}))

// Mock next-intl. Components built since the A2UI subsystem use
// `useTranslations(namespace)` and friends which throw without a
// `NextIntlClientProvider` ancestor. Loading the real English messages and
// resolving keys against them keeps tests that assert on visible text working
// (`getByText("Run")` etc.) without forcing every test to wrap in a provider.
jest.mock("next-intl", () => {
  // Load the canonical English message bundle once. Tests assert on English
  // strings; falling back to the raw key when a path is missing keeps tests
  // that don't have a real translation entry from breaking obscurely.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const messages = require("./i18n/messages/en.json") as Record<string, unknown>

  const resolvePath = (root: Record<string, unknown> | undefined, dottedKey: string): unknown => {
    if (!root) return undefined
    const segments = dottedKey.split(".")
    let cursor: unknown = root
    for (const seg of segments) {
      if (cursor && typeof cursor === "object" && seg in (cursor as Record<string, unknown>)) {
        cursor = (cursor as Record<string, unknown>)[seg]
      } else {
        return undefined
      }
    }
    return cursor
  }

  const interpolate = (template: string, values?: Record<string, unknown>) => {
    if (!values) return template
    // Resolve ICU plural / select syntax. ICU templates have nested braces
    // so a regex with lazy `[\s\S]*?` truncates at the first `}`; we walk
    // the string and track brace depth instead. For each `{name, plural,
    // …}` block we try to match the active branch by value before falling
    // back to `other`, and `#` inside the chosen branch is replaced by
    // the controlling variable's value (per ICU spec).
    let out = ""
    let i = 0
    const headerRe = /\{(\w+),\s*(?:plural|select|selectordinal),\s*/y
    while (i < template.length) {
      headerRe.lastIndex = i
      const header = headerRe.exec(template)
      if (!header) {
        out += template[i]
        i += 1
        continue
      }
      const name = header[1]!
      let j = headerRe.lastIndex
      let depth = 1
      while (j < template.length && depth > 0) {
        const ch = template[j]
        if (ch === "{") depth += 1
        else if (ch === "}") depth -= 1
        if (depth > 0) j += 1
      }
      // template[headerRe.lastIndex..j) is the branches body.
      const body = template.slice(headerRe.lastIndex, j)
      const branches = new Map<string, string>()
      const branchRe = /(=\d+|zero|one|two|few|many|other)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g
      let m: RegExpExecArray | null
      while ((m = branchRe.exec(body)) !== null) {
        branches.set(m[1]!, m[2]!)
      }
      const controlling = values[name]
      const chosen = branches.get(`=${controlling}`) ?? branches.get("other") ?? ""
      out += chosen.replace(/#/g, String(controlling))
      i = j + 1
    }
    out = Object.entries(values).reduce(
      (acc, [k, v]) => acc.replace(new RegExp(`\\{\\s*${k}\\s*\\}`, "g"), String(v)),
      out
    )
    return out
  }

  const makeTranslator = (namespace?: string) => {
    const root = namespace
      ? (resolvePath(messages, namespace) as Record<string, unknown> | undefined)
      : (messages as Record<string, unknown>)
    const t = (key: string, values?: Record<string, unknown>) => {
      const resolved = resolvePath(root, key)
      const template = typeof resolved === "string" ? resolved : key
      return interpolate(template, values)
    }
    ;(t as unknown as { rich: typeof t }).rich = t
    ;(t as unknown as { markup: typeof t }).markup = t
    ;(t as unknown as { has: (k: string) => boolean }).has = (k: string) =>
      typeof resolvePath(root, k) === "string"
    return t
  }

  return {
    useTranslations: (namespace?: string) => makeTranslator(namespace),
    getTranslations: async (namespace?: string) => makeTranslator(namespace),
    useLocale: () => "en",
    useMessages: () => messages,
    useNow: () => new Date(),
    useTimeZone: () => "UTC",
    useFormatter: () => ({
      dateTime: (d: Date | number) => new Date(d).toISOString(),
      number: (n: number) => String(n),
      relativeTime: (d: Date | number) => new Date(d).toISOString(),
      list: (items: Iterable<string>) => Array.from(items).join(", "),
    }),
    NextIntlClientProvider: ({ children }: { children: React.ReactNode }) => children,
  }
})

// Suppress console errors in tests (optional)
// global.console = {
//   ...console,
//   error: jest.fn(),
//   warn: jest.fn(),
// };
