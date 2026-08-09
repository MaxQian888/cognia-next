import { isWorkspaceRestricted, resolveWorkspaceTrustForSend } from "./trust-gate"
import * as trustDb from "@/lib/db/trusted-workspaces"
import type { Project } from "@/types"

jest.mock("@/lib/db/trusted-workspaces")
const trusted = trustDb as jest.Mocked<typeof trustDb>

const project = (paths: string[]): Project =>
  ({
    id: "p",
    name: "P",
    roots: paths.map((p, i) => ({ id: `r${i}`, path: p, isPrimary: i === 0 })),
    knowledgeBase: [],
    sessionIds: [],
    sessionCount: 0,
    messageCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastAccessedAt: new Date(),
  }) as Project

beforeEach(() => {
  trusted.isWorkspaceTrusted.mockResolvedValue(false)
})

it("returns false on Web regardless of trust", async () => {
  expect(await isWorkspaceRestricted(project(["/a"]), { enabled: true, onWeb: true })).toBe(false)
})

it("returns false when trust is disabled", async () => {
  expect(await isWorkspaceRestricted(project(["/a"]), { enabled: false, onWeb: false })).toBe(false)
})

it("returns false for null project", async () => {
  expect(await isWorkspaceRestricted(null, { enabled: true, onWeb: false })).toBe(false)
})

it("returns false for a rootless workspace", async () => {
  expect(await isWorkspaceRestricted(project([]), { enabled: true, onWeb: false })).toBe(false)
})

it("returns true when any root is untrusted", async () => {
  trusted.isWorkspaceTrusted.mockImplementation(async (p) => p === "/a")
  expect(await isWorkspaceRestricted(project(["/a", "/b"]), { enabled: true, onWeb: false })).toBe(
    true
  )
})

it("returns false when every root is trusted", async () => {
  trusted.isWorkspaceTrusted.mockResolvedValue(true)
  expect(await isWorkspaceRestricted(project(["/a", "/b"]), { enabled: true, onWeb: false })).toBe(
    false
  )
})

it("returns roots only when every root has an explicit grant", async () => {
  trusted.isWorkspaceTrusted.mockResolvedValue(true)
  await expect(
    resolveWorkspaceTrustForSend(project(["/a", "/b"]), { enabled: true, onWeb: false })
  ).resolves.toEqual({ restricted: false, trustedRoots: ["/a", "/b"] })

  trusted.isWorkspaceTrusted.mockImplementation(async (p) => p === "/a")
  await expect(
    resolveWorkspaceTrustForSend(project(["/a", "/b"]), { enabled: true, onWeb: false })
  ).resolves.toEqual({ restricted: true, trustedRoots: [] })
})

it("does not mint local-content trust when trust is bypassed", async () => {
  trusted.isWorkspaceTrusted.mockResolvedValue(true)
  await expect(
    resolveWorkspaceTrustForSend(project(["/a"]), { enabled: false, onWeb: false })
  ).resolves.toEqual({ restricted: false, trustedRoots: [] })
  await expect(
    resolveWorkspaceTrustForSend(project(["/a"]), { enabled: true, onWeb: true })
  ).resolves.toEqual({ restricted: false, trustedRoots: [] })
})
