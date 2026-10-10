jest.mock("@/lib/db/sessions", () => ({ getSession: jest.fn() }))
jest.mock("@/lib/db/shared-links", () => ({ listSharedLinksForSession: jest.fn(async () => []) }))
jest.mock("@/lib/files/workspace-fs", () => ({ listWorkspaceDir: jest.fn(async () => []) }))
jest.mock("@/lib/i18n/runtime-translator", () => ({
  getRuntimeTranslator: jest.fn(
    async () => (key: string, values?: Record<string, unknown>) =>
      key === "untitled" ? "Untitled conversation" : `Files from ${String(values?.title)}`
  ),
}))
jest.mock("@/lib/share/client", () => ({
  ...jest.requireActual("@/lib/share/client"),
  revokeShareLink: jest.fn(async () => undefined),
}))
jest.mock("@/lib/share/file-selection", () => ({
  ...jest.requireActual("@/lib/share/file-selection"),
  expandShareSelection: jest.fn(),
}))
jest.mock("./grants-client", () => ({
  ...jest.requireActual("./grants-client"),
  listLiveGrants: jest.fn(async () => []),
  revokeLiveGrant: jest.fn(async () => ({})),
}))
jest.mock("./live-share", () => ({ createLiveFileShare: jest.fn(async () => ({})) }))
jest.mock("./load", () => ({ loadConversationFileSpace: jest.fn() }))
jest.mock("./policy", () => ({
  ...jest.requireActual("./policy"),
  loadEffectiveFileSharingPolicy: jest.fn(),
}))
jest.mock("./share-files", () => ({
  ...jest.requireActual("./share-files"),
  createFileShare: jest.fn(async () => ({ code: "C", url: "u" })),
}))

import { listSharedLinksForSession } from "@/lib/db/shared-links"
import { listWorkspaceDir } from "@/lib/files/workspace-fs"
import {
  revokeShareLink,
  ShareFilesUploadError,
  ShareNotConfiguredError,
  ShareRequestError,
} from "@/lib/share/client"

import {
  describeFilespaceToolError,
  resolveFilespaceToolDeps,
  resolveFilespaceToolSurface,
} from "./agent-tool-deps"
import { listLiveGrants, revokeLiveGrant } from "./grants-client"
import { createLiveFileShare } from "./live-share"
import { createFileShare, FileShareRefusedError } from "./share-files"

describe("describeFilespaceToolError", () => {
  it("names each layer's refusal by a stable code", () => {
    expect(
      describeFilespaceToolError(new FileShareRefusedError("public-snapshots-disabled")).code
    ).toBe("public-snapshots-disabled")
    expect(describeFilespaceToolError(new ShareNotConfiguredError()).code).toBe(
      "share-not-configured"
    )
    expect(describeFilespaceToolError(new ShareFilesUploadError(false, null)).code).toBe(
      "upload-failed-link-live"
    )
    expect(describeFilespaceToolError(new ShareRequestError(503, "busy")).code).toBe(
      "share-server-503"
    )
    expect(
      describeFilespaceToolError({ code: "policy_agent_disabled", message: "no", retryable: false })
    ).toEqual({ code: "policy_agent_disabled", message: "no" })
  })
})

describe("resolveFilespaceToolDeps", () => {
  it("routes each effect through the same modules the Files panel uses", async () => {
    const deps = resolveFilespaceToolDeps()
    await deps.listDir("/root", "src")
    expect(listWorkspaceDir).toHaveBeenCalledWith("/root", "src", false)
    await deps.listShareLinks("s1")
    expect(listSharedLinksForSession).toHaveBeenCalledWith("s1")
    await deps.revokeShareLink("C")
    expect(revokeShareLink).toHaveBeenCalledWith("C")
    await deps.listLiveGrants("s1", "host-a")
    expect(listLiveGrants).toHaveBeenCalledWith({ sessionId: "s1" }, { hostId: "host-a" })
    await deps.revokeLiveGrant("fg_1", "host-a")
    expect(revokeLiveGrant).toHaveBeenCalledWith("fg_1", { hostId: "host-a" })
    const request = {
      sessionId: "s1",
      paths: ["/workspace"],
      permissions: ["read" as const],
      protocols: ["webdav" as const],
      expiresInSeconds: 3600,
    }
    await deps.createLiveShare(request, "host-a")
    expect(createLiveFileShare).toHaveBeenCalledWith(request, { hostId: "host-a" })
    await deps.createSnapshotShare({ files: [] } as never)
    expect(createFileShare).toHaveBeenCalledWith({ files: [] })
  })

  it("titles a snapshot after the conversation, in the person's language", async () => {
    const deps = resolveFilespaceToolDeps()
    await expect(deps.bundleTitle("Design review")).resolves.toBe("Files from Design review")
    await expect(deps.bundleTitle("  ")).resolves.toBe("Files from Untitled conversation")
  })
})

describe("resolveFilespaceToolSurface", () => {
  const allowing = async () => ({ policy: { allowAgentSharing: true } }) as never

  it("offers reading and revoking to any conversation outside the CLI", async () => {
    const loadPolicy = jest.fn(allowing)
    await expect(
      resolveFilespaceToolSurface(
        { hasSession: true, cliHost: false, fileSharing: undefined },
        loadPolicy
      )
    ).resolves.toEqual({ surfaced: true, sharing: false })
    // The person's own policy says no: the org is never asked.
    expect(loadPolicy).not.toHaveBeenCalled()
    await expect(
      resolveFilespaceToolSurface(
        { hasSession: true, cliHost: true, fileSharing: undefined },
        loadPolicy
      )
    ).resolves.toEqual({ surfaced: false, sharing: false })
    await expect(
      resolveFilespaceToolSurface(
        { hasSession: false, cliHost: false, fileSharing: undefined },
        loadPolicy
      )
    ).resolves.toEqual({ surfaced: false, sharing: false })
  })

  it("offers sharing only when the effective policy allows it", async () => {
    const own = { allowAgentSharing: true }
    await expect(
      resolveFilespaceToolSurface({ hasSession: true, cliHost: false, fileSharing: own }, allowing)
    ).resolves.toEqual({ surfaced: true, sharing: true })
    await expect(
      resolveFilespaceToolSurface(
        { hasSession: true, cliHost: false, fileSharing: own },
        async () => ({ policy: { allowAgentSharing: false } }) as never
      )
    ).resolves.toEqual({ surfaced: true, sharing: false })
    await expect(
      resolveFilespaceToolSurface(
        { hasSession: true, cliHost: false, fileSharing: own },
        async () => {
          throw new Error("plane down")
        }
      )
    ).resolves.toEqual({ surfaced: true, sharing: false })
  })
})
