/**
 * Jest setup file
 * This file is executed before each test file
 */

import "@testing-library/jest-dom"
import React from "react"

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

// Suppress console errors in tests (optional)
// global.console = {
//   ...console,
//   error: jest.fn(),
//   warn: jest.fn(),
// };
