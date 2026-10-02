import { renderHook } from "@testing-library/react"

import {
  DEFAULT_STATUS_API_BASE,
  DEFAULT_STATUS_PAGE_URL,
  STATUS_RUNTIME_META_NAME,
} from "@/lib/status/public-status"

import { currentStatusRuntime, readStatusRuntimeMeta, useStatusRuntime } from "./use-status-runtime"

function setMeta(content: string | null) {
  document.head
    .querySelectorAll(`meta[name="${STATUS_RUNTIME_META_NAME}"]`)
    .forEach((node) => node.remove())
  if (content === null) return
  const meta = document.createElement("meta")
  meta.name = STATUS_RUNTIME_META_NAME
  meta.content = content
  document.head.appendChild(meta)
}

afterEach(() => setMeta(null))

describe("status runtime", () => {
  it("is the in-app runtime against the official API when no meta is injected", () => {
    const runtime = currentStatusRuntime()
    expect(runtime).toMatchObject({
      mode: "app",
      apiBase: DEFAULT_STATUS_API_BASE,
      primaryPageUrl: DEFAULT_STATUS_PAGE_URL,
      allowsConsentWrites: false,
    })
  })

  it("reads the primary Worker's same-origin API from the injected meta", () => {
    setMeta(JSON.stringify({ mode: "primary", apiBase: "/api/status/v1" }))
    expect(readStatusRuntimeMeta(document)).toContain("primary")
    expect(currentStatusRuntime()).toMatchObject({
      mode: "primary",
      apiBase: "/api/status/v1",
      allowsConsentWrites: true,
    })
  })

  it("is read-only on a mirror", () => {
    setMeta(JSON.stringify({ mode: "mirror", apiBase: "/mirror/api" }))
    expect(currentStatusRuntime()).toMatchObject({ mode: "mirror", allowsConsentWrites: false })
  })

  it("ignores a meta that points at a foreign host", () => {
    setMeta(JSON.stringify({ mode: "primary", apiBase: "//evil.example/api" }))
    expect(currentStatusRuntime().mode).toBe("app")
  })

  it("returns a stable object while the inputs are unchanged", () => {
    setMeta(JSON.stringify({ mode: "primary", apiBase: "/api/status/v1" }))
    expect(currentStatusRuntime()).toBe(currentStatusRuntime())
  })

  it("resolves on the client through the hook", () => {
    setMeta(JSON.stringify({ mode: "primary", apiBase: "/api/status/v1" }))
    const { result } = renderHook(() => useStatusRuntime())
    expect(result.current?.mode).toBe("primary")
  })
})
