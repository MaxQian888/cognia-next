import { act, renderHook, waitFor } from "@testing-library/react"

import { useSitePreviewSession, type SitePreviewSessionDeps } from "./use-site-preview-session"

function session(url: string) {
  return { siteId: "site_1", terminalSessionId: "terminal-1", url }
}

function deps(overrides: Partial<SitePreviewSessionDeps> = {}): SitePreviewSessionDeps {
  return {
    resume: jest.fn(async () => undefined),
    ...overrides,
  }
}

it("adopts a session the module map still tracks", async () => {
  // `resumeSitePreviewSession` hands back the tracked session when the module
  // map still holds one, so the hook needs no separate synchronous peek.
  const injected = deps({ resume: jest.fn(async () => session("http://localhost:5173")) })
  const { result } = renderHook(() => useSitePreviewSession("site_1", injected))
  await waitFor(() => expect(result.current.url).toBe("http://localhost:5173"))
})

it("recovers a preview that outlived the component and marks itself resolved", async () => {
  const injected = deps({ resume: jest.fn(async () => session("http://localhost:3000")) })
  const { result } = renderHook(() => useSitePreviewSession("site_1", injected))

  expect(result.current.resolved).toBe(false)
  await waitFor(() => expect(result.current.resolved).toBe(true))
  expect(result.current.url).toBe("http://localhost:3000")
  expect(injected.resume).toHaveBeenCalledWith("site_1")
})

it("resolves to no preview when nothing is running", async () => {
  const { result } = renderHook(() => useSitePreviewSession("site_1", deps()))
  await waitFor(() => expect(result.current.resolved).toBe(true))
  expect(result.current.url).toBeNull()
})

it("settles even when resume rejects", async () => {
  const { result } = renderHook(() =>
    useSitePreviewSession(
      "site_1",
      deps({
        resume: jest.fn(async () => {
          throw new Error("boom")
        }),
      })
    )
  )
  await waitFor(() => expect(result.current.resolved).toBe(true))
  expect(result.current.url).toBeNull()
})

it("records a preview this session started and clears it on stop", async () => {
  const { result } = renderHook(() => useSitePreviewSession("site_1", deps()))
  await waitFor(() => expect(result.current.resolved).toBe(true))

  act(() => result.current.adopt("http://localhost:4321"))
  expect(result.current.url).toBe("http://localhost:4321")

  act(() => result.current.adopt(null))
  expect(result.current.url).toBeNull()
})

it("re-resolves when the selected Site changes and clears with no selection", async () => {
  const resume = jest.fn(async (siteId: string) =>
    siteId === "site_2" ? session("http://localhost:9") : undefined
  )
  const injected = deps({ resume })
  const { result, rerender } = renderHook(
    ({ id }: { id: string | null }) => useSitePreviewSession(id, injected),
    { initialProps: { id: "site_1" as string | null } }
  )
  await waitFor(() => expect(result.current.resolved).toBe(true))

  rerender({ id: "site_2" })
  await waitFor(() => expect(result.current.url).toBe("http://localhost:9"))

  rerender({ id: null })
  await waitFor(() => expect(result.current.url).toBeNull())
  expect(resume).toHaveBeenCalledTimes(2)
})

it("does not restart when the caller rebuilds its dependency object", async () => {
  const resume = jest.fn(async () => undefined)
  const { result, rerender } = renderHook(() => useSitePreviewSession("site_1", deps({ resume })))
  await waitFor(() => expect(result.current.resolved).toBe(true))
  rerender()
  rerender()
  expect(resume).toHaveBeenCalledTimes(1)
})

it("reports unresolved while a different Site's answer is still the one in hand", async () => {
  const resume = jest.fn(async (siteId: string) => session(`http://localhost/${siteId}`))
  const injected = deps({ resume })
  const { result, rerender } = renderHook(
    ({ id }: { id: string }) => useSitePreviewSession(id, injected),
    { initialProps: { id: "site_1" } }
  )
  await waitFor(() => expect(result.current.url).toBe("http://localhost/site_1"))

  rerender({ id: "site_2" })
  // The previous Site's URL must not leak into the newly selected one.
  expect(result.current.resolved).toBe(false)
  expect(result.current.url).toBeNull()
  await waitFor(() => expect(result.current.url).toBe("http://localhost/site_2"))
})
