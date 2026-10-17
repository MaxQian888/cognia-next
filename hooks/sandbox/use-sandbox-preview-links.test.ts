/** @jest-environment jsdom */
import { act, renderHook, waitFor } from "@testing-library/react"
import { useSandboxPreviewLinks } from "./use-sandbox-preview-links"
import {
  sandboxPreviewCreate,
  sandboxPreviewList,
  sandboxPreviewOpen,
  sandboxPreviewRevoke,
} from "@/lib/sandbox/previews"
import { writeClipboardText } from "@/lib/tauri/clipboard"
import { requestBrowserUrl } from "@/lib/browser/open-url-request"

jest.mock("@/lib/sandbox/previews", () => ({
  sandboxPreviewCreate: jest.fn(),
  sandboxPreviewList: jest.fn(),
  sandboxPreviewOpen: jest.fn(),
  sandboxPreviewRevoke: jest.fn(),
}))
jest.mock("@/lib/tauri/clipboard", () => ({ writeClipboardText: jest.fn() }))
jest.mock("@/lib/browser/open-url-request", () => ({ requestBrowserUrl: jest.fn() }))
const list = jest.mocked(sandboxPreviewList)
const create = jest.mocked(sandboxPreviewCreate)
const open = jest.mocked(sandboxPreviewOpen)
const revoke = jest.mocked(sandboxPreviewRevoke)
const grant = {
  version: 1,
  id: "g",
  projectId: "p",
  workspaceId: "w",
  provider: "local",
  containerId: "c",
  runtimeGeneration: "r",
  port: { kind: "fixed" as const, port: 3000 },
  resolvedPort: 3000,
  portLease: null,
  audience: { kind: "localOwner" as const },
  createdAt: Date.now(),
  expiresAt: Date.now() + 900_000,
  revision: 1,
  revoked: false,
  origin: "http://p-g.localhost:4000",
}
const request = { workspaceId: "w", provider: "local", containerId: "c", port: grant.port }
beforeEach(() => {
  jest.clearAllMocks()
  list.mockResolvedValue([])
  create.mockResolvedValue({ grant, bootstrapUrl: `${grant.origin}/__cognia_bootstrap#secret` })
  open.mockResolvedValue({ grant, bootstrapUrl: `${grant.origin}/__cognia_bootstrap#fresh` })
  revoke.mockResolvedValue({ ...grant, revoked: true })
  jest.mocked(requestBrowserUrl).mockReturnValue(true)
})

it("copies a capability once, keeps it out of list metadata and defaults to the local owner", async () => {
  const { result } = renderHook(() => useSandboxPreviewLinks("p"))
  await waitFor(() => expect(result.current.loading).toBe(false))
  await act(() => result.current.create(request))
  expect(create).toHaveBeenCalledWith({
    ...request,
    projectId: "p",
    audience: { kind: "localOwner" },
  })
  expect(JSON.stringify(result.current.grants)).not.toContain("secret")
  await act(() => result.current.copy("g"))
  await act(() => result.current.copy("g"))
  expect(writeClipboardText).toHaveBeenCalledTimes(1)
  expect(result.current.copyable).toEqual([])
})

it("shares a grant with one paired device without holding any copy capability", async () => {
  const audience = { kind: "pairedDevice" as const, deviceId: "desk" }
  const paired = { ...grant, audience, origin: "/api/sandbox/previews/g/" }
  create.mockResolvedValueOnce({ grant: paired, bootstrapUrl: paired.origin })
  const { result } = renderHook(() => useSandboxPreviewLinks("p"))
  await waitFor(() => expect(result.current.loading).toBe(false))
  await act(() => result.current.create(request, audience))
  expect(create).toHaveBeenCalledWith({ ...request, projectId: "p", audience })
  expect(result.current.grants).toEqual([paired])
  expect(result.current.copyable).toEqual([])
})

it("uses the embedded backend and reports an unclaimed browser without external fallback", async () => {
  jest.mocked(requestBrowserUrl).mockReturnValue(false)
  const { result } = renderHook(() => useSandboxPreviewLinks("p"))
  await waitFor(() => expect(result.current.loading).toBe(false))
  await act(() => result.current.open("g"))
  expect(requestBrowserUrl).toHaveBeenCalledWith(expect.stringContaining("#fresh"), {
    backend: "embedded",
    source: "user",
  })
  expect(result.current.error).toBe("browser")
})

it("revokes the grant and drops any pending copy capability", async () => {
  const { result } = renderHook(() => useSandboxPreviewLinks("p"))
  await waitFor(() => expect(result.current.loading).toBe(false))
  await act(() => result.current.create(request))
  await act(() => result.current.revoke("g"))
  expect(result.current.grants[0].revoked).toBe(true)
  expect(result.current.copyable).toEqual([])
})

it("discards late capabilities after switching projects", async () => {
  let resolve!: (value: { grant: typeof grant; bootstrapUrl: string }) => void
  create.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done
      })
  )
  const { result, rerender } = renderHook(({ project }) => useSandboxPreviewLinks(project), {
    initialProps: { project: "p" },
  })
  await waitFor(() => expect(result.current.loading).toBe(false))
  let pending!: Promise<void>
  act(() => {
    pending = result.current.create(request)
  })
  rerender({ project: "other" })
  await act(async () => {
    resolve({ grant, bootstrapUrl: "secret" })
    await pending
  })
  expect(result.current.grants).toEqual([])
  expect(result.current.copyable).toEqual([])
})

it("expires the copy capability after 60 seconds", async () => {
  jest.useFakeTimers()
  try {
    const { result } = renderHook(() => useSandboxPreviewLinks("p"))
    await act(async () => {})
    await act(() => result.current.create(request))
    act(() => {
      jest.advanceTimersByTime(60_000)
    })
    expect(result.current.copyable).toEqual([])
  } finally {
    jest.useRealTimers()
  }
})
