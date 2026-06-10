/**
 * @jest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

jest.mock("sonner", () => ({ toast: { error: jest.fn(), success: jest.fn() } }))

type FakeState = { activeProjectId: string | null; projects: unknown[] }
let fakeState: FakeState = { activeProjectId: null, projects: [] }
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: (selector: (s: FakeState) => unknown) => selector(fakeState),
}))

jest.mock("@/lib/file/file-operations", () => ({
  readTextFile: jest.fn(),
  writeTextFile: jest.fn(),
  readBinaryFile: jest.fn(),
  writeBinaryFile: jest.fn(),
  removeFile: jest.fn(),
  copyFile: jest.fn(),
  renameFile: jest.fn(),
  statFile: jest.fn(),
  readDir: jest.fn(),
  createDir: jest.fn(),
  exists: jest.fn(),
}))

jest.mock("@/lib/logging", () => ({
  loggers: { files: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } },
}))

import { useSecureFileOps } from "./use-secure-file-ops"
import { resetFileAuditForTest, getFileAudit } from "@/lib/files/audit"
import * as fileOps from "@/lib/file/file-operations"
import { toast } from "sonner"

const ops = fileOps as jest.Mocked<typeof fileOps>
const toastMock = toast as unknown as { error: jest.Mock; success: jest.Mock }

function withProject() {
  fakeState = {
    activeProjectId: "p1",
    projects: [{ id: "p1", roots: [{ id: "r1", path: "/w", isPrimary: true }] }],
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  resetFileAuditForTest()
  fakeState = { activeProjectId: null, projects: [] }
})

describe("useSecureFileOps", () => {
  it("is not ready and denies access with no workspace roots", async () => {
    const { result } = renderHook(() => useSecureFileOps())
    expect(result.current.ready).toBe(false)
    expect(result.current.policy.allowedRoots).toEqual([])

    let value: string | null = "x"
    await act(async () => {
      value = await result.current.readText("/w/a.txt")
    })
    expect(value).toBeNull()
    expect(ops.readTextFile).not.toHaveBeenCalled()
    expect(toastMock.error).toHaveBeenCalledWith("denied")
  })

  it("derives a policy from the active workspace roots", () => {
    withProject()
    const { result } = renderHook(() => useSecureFileOps())
    expect(result.current.ready).toBe(true)
    expect(result.current.policy.allowedRoots).toEqual(["/w"])
  })

  it("reads inside the workspace and records audit", async () => {
    withProject()
    ops.readTextFile.mockResolvedValue("hello")
    const { result } = renderHook(() => useSecureFileOps())

    let value: string | null = null
    await act(async () => {
      value = await result.current.readText("/w/a.txt")
    })
    expect(value).toBe("hello")
    expect(ops.readTextFile).toHaveBeenCalledWith("/w/a.txt")
    await waitFor(() => expect(result.current.recentAudit.length).toBe(1))
    expect(result.current.recentAudit[0]).toMatchObject({ op: "read", allowed: true })
  })

  it("writeText returns true on success, false + toast on denial", async () => {
    withProject()
    ops.writeTextFile.mockResolvedValue(undefined)
    const { result } = renderHook(() => useSecureFileOps())

    let ok = false
    await act(async () => {
      ok = await result.current.writeText("/w/a.txt", "data")
    })
    expect(ok).toBe(true)

    let denied = true
    await act(async () => {
      denied = await result.current.writeText("/etc/passwd", "data")
    })
    expect(denied).toBe(false)
    expect(toastMock.error).toHaveBeenCalledWith("denied")
  })

  it("remove returns false + toasts failed on a runtime error", async () => {
    withProject()
    ops.removeFile.mockRejectedValue(new Error("EPERM"))
    const { result } = renderHook(() => useSecureFileOps())

    let ok = true
    await act(async () => {
      ok = await result.current.remove("/w/a.txt")
    })
    expect(ok).toBe(false)
    expect(toastMock.error).toHaveBeenCalledWith("failed")
  })

  it("respects an explicit policy and policyOverrides", async () => {
    withProject()
    ops.writeTextFile.mockResolvedValue(undefined)
    const { result } = renderHook(() => useSecureFileOps({ policyOverrides: { readOnly: true } }))
    let ok = true
    await act(async () => {
      ok = await result.current.writeText("/w/a.txt", "x")
    })
    expect(ok).toBe(false)
    expect(ops.writeTextFile).not.toHaveBeenCalled()
  })

  it("clearAudit empties the buffer and toasts", async () => {
    withProject()
    ops.readTextFile.mockResolvedValue("x")
    const { result } = renderHook(() => useSecureFileOps())
    await act(async () => {
      await result.current.readText("/w/a.txt")
    })
    expect(getFileAudit().length).toBe(1)
    act(() => result.current.clearAudit())
    expect(getFileAudit().length).toBe(0)
    expect(toastMock.success).toHaveBeenCalledWith("auditCleared")
  })

  it("suppresses toasts when toastOnError is false", async () => {
    withProject()
    const { result } = renderHook(() => useSecureFileOps({ toastOnError: false }))
    await act(async () => {
      await result.current.readText("/etc/passwd")
    })
    expect(toastMock.error).not.toHaveBeenCalled()
  })

  it("clearAudit stays silent when toastOnError is false", () => {
    withProject()
    const { result } = renderHook(() => useSecureFileOps({ toastOnError: false }))
    act(() => result.current.clearAudit())
    expect(toastMock.success).not.toHaveBeenCalled()
  })

  it("honors an explicit policy with allowAnyPath", async () => {
    // No active project, but an explicit allow-any policy → ready + reads pass.
    ops.readTextFile.mockResolvedValue("ok")
    const { result } = renderHook(() =>
      useSecureFileOps({ policy: { allowedRoots: [], allowAnyPath: true } })
    )
    expect(result.current.ready).toBe(true)
    let value: string | null = null
    await act(async () => {
      value = await result.current.readText("/anywhere/a.txt")
    })
    expect(value).toBe("ok")
  })

  it("toasts 'failed' for a non-Error rejection", async () => {
    withProject()
    ops.readTextFile.mockRejectedValue("boom")
    const { result } = renderHook(() => useSecureFileOps())
    let value: string | null = "x"
    await act(async () => {
      value = await result.current.readText("/w/a.txt")
    })
    expect(value).toBeNull()
    expect(toastMock.error).toHaveBeenCalledWith("failed")
  })
})
