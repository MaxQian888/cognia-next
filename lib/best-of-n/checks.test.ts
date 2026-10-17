jest.mock("@/lib/task-workspace/client", () => ({
  acquireWorkspaceBundle: jest.fn(),
  archiveManagedWorkspace: jest.fn(),
}))
jest.mock("@/lib/task-workspace/user-action", () => ({
  runWorkspaceUserAction: jest.fn((_command, action) => action()),
}))
jest.mock("@/lib/scm/runtime", () => ({ createScmRuntime: jest.fn() }))
import { acquireWorkspaceBundle, archiveManagedWorkspace } from "@/lib/task-workspace/client"
import { createScmRuntime } from "@/lib/scm/runtime"
import { checkBestOfNHead } from "./checks"
import type { AgentChangeset } from "@/lib/scm/types"
import type { BestOfNGroup } from "@/types/best-of-n"

const group = { groupId: "g", repositoryId: "repo", sourceRoot: "/source" } as BestOfNGroup
const changeset = {
  changesetId: "cs",
  headSha: "pinned",
  executionRoot: "/dirty-attempt",
} as AgentChangeset
beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(acquireWorkspaceBundle).mockResolvedValue({
    state: "active",
    leases: [{ workspaceId: "verification", aliasPath: "/frozen", role: "primary" }],
  } as never)
  jest.mocked(archiveManagedWorkspace).mockResolvedValue({} as never)
})

it("checks a fresh committed-head checkout with no AI reviewer and archives it", async () => {
  const review = jest.fn().mockResolvedValue({ changeset, checks: [], policy: null })
  jest.mocked(createScmRuntime).mockReturnValue({ review } as never)
  const host = { getChangeset: jest.fn().mockResolvedValue(changeset) }
  await checkBestOfNHead(group, changeset, "project", host as never, new AbortController().signal)
  expect(acquireWorkspaceBundle).toHaveBeenCalledWith(
    expect.objectContaining({
      base: { kind: "gitRef", gitRef: "pinned" },
      roots: [{ logicalRootId: "repo", role: "primary", sourceRoot: "/source" }],
    })
  )
  const input = jest.mocked(createScmRuntime).mock.calls[0][0]
  expect(input.appSettings).toBeNull()
  expect(input.configRoot).toBe("/source")
  expect((await input.host!.getChangeset("cs"))?.executionRoot).toBe("/frozen")
  expect(archiveManagedWorkspace).toHaveBeenCalledWith("verification")
})

it("refuses a moved head before review and still archives the check workspace", async () => {
  jest.mocked(createScmRuntime).mockImplementation(
    (input) =>
      ({
        review: () => input.host!.getChangeset("cs"),
      }) as never
  )
  const host = { getChangeset: jest.fn().mockResolvedValue({ ...changeset, headSha: "moved" }) }
  await expect(
    checkBestOfNHead(group, changeset, "project", host as never, new AbortController().signal)
  ).rejects.toThrow("head changed")
  expect(archiveManagedWorkspace).toHaveBeenCalledWith("verification")
})
