import type { ChatSession } from "@cognia/agent-config-types"
import type { SharedLinkRow } from "@/lib/db/shared-links"
import type { LoadedConversationFileSpace } from "@/lib/filespace/load"
import {
  DEFAULT_FILE_SHARING_POLICY,
  type EffectiveFileSharingPolicy,
} from "@/lib/filespace/policy"
import type { ShareFileCandidate } from "@/lib/share/file-selection"
import type { ConversationFileSpace, FileSpacePath } from "@/types/filespace"
import type { CreatedLiveGrant, LiveGrant, LiveGrantView } from "@/types/filespace/live"

import {
  buildFilespaceManifestEntries,
  FILESPACE_SHARING_TOOL_NAMES,
  FILESPACE_TOOL_NAMES as T,
  isFilespaceBuiltinTool,
  runFilespaceBuiltinTool,
  type FilespaceToolDeps,
} from "./filespace-builtin-tools"

const p = (value: string) => value as FileSpacePath

const space: ConversationFileSpace = {
  sessionId: "s1",
  status: "available",
  hostId: "local",
  mounts: [
    {
      id: "workspace",
      virtualPath: "/workspace",
      backing: "disk",
      label: "repo",
      hostPath: "/home/me/repo",
      managed: false,
      role: "primary",
      writable: true,
      status: "available",
    },
    {
      id: "uploads",
      virtualPath: "/uploads",
      backing: "dexie",
      label: "Uploads",
      managed: false,
      writable: false,
      status: "available",
    },
  ],
}

const loaded: LoadedConversationFileSpace = {
  space,
  dexie: {
    uploads: [
      {
        mountId: "uploads",
        path: p("/uploads/report.pdf"),
        name: "report.pdf",
        size: 10,
        mediaType: "application/pdf",
        createdAt: 1,
        updatedAt: 1,
        sourceId: "a1",
        sourceAvailable: true,
      },
      {
        mountId: "uploads",
        path: p("/uploads/.env"),
        name: ".env",
        size: 3,
        mediaType: "text/plain",
        createdAt: 1,
        updatedAt: 1,
        sourceId: "a2",
        sourceAvailable: true,
      },
    ],
    artifacts: [],
  },
}

const session = { id: "s1", title: "Design review" } as ChatSession

function policy(patch: Partial<EffectiveFileSharingPolicy["policy"]> = {}) {
  const value = {
    ...DEFAULT_FILE_SHARING_POLICY,
    allowAgentSharing: true,
    allowProtocolCredentials: true,
    ...patch,
  }
  return { policy: value, local: value }
}

function grant(id: string, patch: Partial<LiveGrant> = {}): LiveGrantView {
  return {
    grant: {
      id,
      sessionId: "s1",
      label: null,
      createdBy: "user",
      creatorPrincipal: "owner",
      protocols: ["webdav"],
      provider: "builtin",
      permissions: ["read", "download"],
      status: "active",
      statusReason: null,
      expiresAt: 9_000_000,
      policyRevision: 1,
      createdAt: 1,
      updatedAt: 1,
      revokedAt: null,
      audience: { kind: "credentials" },
      paths: [
        {
          mountId: "workspace",
          relPath: "",
          isDir: true,
          mountFingerprint: "fp",
          virtualPath: "/workspace",
        },
      ],
      ...patch,
    },
    credentials: [
      {
        id: `fc_${id}`,
        grantId: id,
        protocol: "webdav",
        provider: "builtin",
        username: `cg_${id}`,
        sshKeyFingerprint: null,
        createdAt: 1,
        rotatedAt: null,
        revokedAt: null,
      },
    ],
  }
}

const candidate = (path: string, sensitive = false): ShareFileCandidate => ({
  path: p(path),
  name: path.slice(path.lastIndexOf("/") + 1),
  mime: "text/plain",
  size: 5,
  sensitive,
  open: jest.fn(),
})

function deps(patch: Partial<FilespaceToolDeps> = {}): FilespaceToolDeps {
  return {
    getSession: jest.fn(async () => session),
    loadFileSpace: jest.fn(async () => loaded),
    loadPolicy: jest.fn(async () => policy()),
    listDir: jest.fn(async () => [
      { relPath: "src", absolutePath: "/home/me/repo/src", isDir: true, size: 0, mtimeMs: null },
      { relPath: ".env", absolutePath: "/home/me/repo/.env", isDir: false, size: 9, mtimeMs: null },
      {
        relPath: "README.md",
        absolutePath: "/home/me/repo/README.md",
        isDir: false,
        size: 42,
        mtimeMs: null,
      },
    ]),
    expandSelection: jest.fn(async () => ({
      files: [candidate("/workspace/src/a.ts"), candidate("/workspace/src/.env", true)],
      skippedSensitive: 1,
      truncated: false,
      issues: [],
    })),
    createSnapshotShare: jest.fn(async () => ({
      code: "AbC123",
      url: "https://share.example/s/AbC123#key",
      expiresAt: 5_000,
    })),
    listShareLinks: jest.fn(
      async () =>
        [
          { code: "MINE", title: "Files from Design review", createdAt: 1, files: [{}, {}] },
        ] as unknown as SharedLinkRow[]
    ),
    revokeShareLink: jest.fn(async () => undefined),
    listLiveGrants: jest.fn(async () => [grant("fg_1")]),
    createLiveShare: jest.fn(
      async (request) =>
        ({
          grant: {
            ...grant("fg_new").grant,
            createdBy: "agent",
            permissions: request.permissions,
            protocols: request.protocols,
          },
          credentials: [
            {
              credential: grant("fg_new").credentials[0]!,
              password: "s3cret-password-never-returned",
            },
          ],
          endpoints: {
            webdavUrls: ["https://192.168.1.2:27893/"],
            sftp: [],
            sftpHostKeyFingerprint: null,
            tlsFingerprint: "SHA256:tls",
            unavailableReason: null,
          },
        }) as CreatedLiveGrant
    ),
    revokeLiveGrant: jest.fn(async (id) => grant(id, { status: "revoked" })),
    bundleTitle: jest.fn(async (title) => `Files from ${title}`),
    describeError: jest.fn((error: unknown) => ({
      code: (error as { code?: string }).code ?? "unknown",
      message: error instanceof Error ? error.message : String(error),
    })),
    now: () => 1_000,
    ...patch,
  }
}

const run = (name: string, args: Record<string, unknown>, d: FilespaceToolDeps, sessionId = "s1") =>
  runFilespaceBuiltinTool(name, args, d, { sessionId }) as Promise<Record<string, unknown>>

describe("the filespace manifest", () => {
  it("offers only reading and revoking unless agent sharing is allowed", () => {
    const names = buildFilespaceManifestEntries({ sharing: false }).map((entry) => entry.name)
    expect(names).toEqual([T.list, T.revokeShare, T.disableWebdav])
  })

  it("adds the sharing tools, each asking on every call", () => {
    const entries = buildFilespaceManifestEntries({ sharing: true })
    expect(entries.map((entry) => entry.name)).toEqual([
      T.list,
      T.revokeShare,
      T.disableWebdav,
      T.share,
      T.enableWebdav,
    ])
    for (const entry of entries) {
      expect(entry.pluginId).toBe("cognia-filespace-builtin")
      expect(entry.requiresApproval === true).toBe(FILESPACE_SHARING_TOOL_NAMES.has(entry.name))
    }
  })

  it("recognises its own names only", () => {
    expect(isFilespaceBuiltinTool(T.share)).toBe(true)
    expect(isFilespaceBuiltinTool("artifact_create")).toBe(false)
  })
})

describe("runFilespaceBuiltinTool", () => {
  it("refuses without the calling conversation instead of guessing one", async () => {
    const d = deps()
    const result = await run(T.list, {}, d, "")
    expect(result.ok).toBe(false)
    expect(d.loadFileSpace).not.toHaveBeenCalled()
  })

  it("never throws: a failing host comes back as a coded refusal", async () => {
    const d = deps({
      loadFileSpace: jest.fn(async () => {
        throw Object.assign(new Error("host down"), { code: "file_share_unavailable" })
      }),
    })
    await expect(run(T.list, {}, d)).resolves.toEqual({
      ok: false,
      code: "file_share_unavailable",
      error: "host down",
    })
  })
})

describe("filespace_list", () => {
  it("lists mounts, this conversation's links (without their keys) and live access", async () => {
    const members = grant("fg_2", {
      protocols: [],
      audience: {
        kind: "collab",
        orgId: "org_1",
        collabSessionId: "ses_1",
        userIds: ["usr_a", "usr_b"],
        minRole: "member",
      },
    })
    const result = await run(
      T.list,
      {},
      deps({
        listLiveGrants: jest.fn(async () => [grant("fg_1"), { ...members, credentials: [] }]),
      })
    )
    expect(result.mounts).toEqual([
      expect.objectContaining({ path: "/workspace", kind: "folder", writable: true }),
      expect.objectContaining({ path: "/uploads", kind: "uploads", writable: false }),
    ])
    expect(result.shares).toEqual([
      { code: "MINE", title: "Files from Design review", createdAt: 1, files: 2 },
    ])
    expect(JSON.stringify(result)).not.toContain("#")
    expect(result.liveAccess).toEqual([
      expect.objectContaining({
        grantId: "fg_1",
        audience: { kind: "credentials" },
        usernames: [{ protocol: "webdav", username: "cg_fg_1" }],
      }),
      expect.objectContaining({
        grantId: "fg_2",
        audience: { kind: "members", minRole: "member", chosenMembers: 2 },
        usernames: [],
      }),
    ])
  })

  it("lists a folder's entries and withholds names the sensitive floor refuses", async () => {
    const d = deps()
    const result = await run(T.list, { path: "/workspace" }, d)
    expect(d.listDir).toHaveBeenCalledWith("/home/me/repo", undefined)
    expect(result.entries).toEqual({
      path: "/workspace",
      items: [
        { path: "/workspace/src", name: "src", type: "folder" },
        { path: "/workspace/README.md", name: "README.md", type: "file", size: 42 },
      ],
      withheldSensitive: 1,
    })
  })

  it("lists uploads the same way", async () => {
    const result = await run(T.list, { path: "/uploads" }, deps())
    expect(result.entries).toEqual({
      path: "/uploads",
      items: [{ path: "/uploads/report.pdf", name: "report.pdf", type: "file", size: 10 }],
      withheldSensitive: 1,
    })
  })

  it("refuses a path outside this conversation's files", async () => {
    const result = await run(T.list, { path: "/etc" }, deps())
    expect(result).toMatchObject({ ok: false })
  })

  it("still lists when the host cannot say what is shared live", async () => {
    const d = deps({
      listLiveGrants: jest.fn(async () => {
        throw Object.assign(new Error("off"), { code: "file_share_unavailable" })
      }),
    })
    const result = await run(T.list, {}, d)
    expect(result.ok).toBe(true)
    expect(result.liveAccess).toEqual({ unavailable: "file_share_unavailable" })
  })
})

describe("filespace_share", () => {
  it("re-checks the policy at call time", async () => {
    const d = deps({ loadPolicy: jest.fn(async () => policy({ allowAgentSharing: false })) })
    const result = await run(T.share, { paths: ["/workspace/src"], mode: "snapshot" }, d)
    expect(result).toMatchObject({ ok: false, code: "policy_agent_disabled" })
    expect(d.createSnapshotShare).not.toHaveBeenCalled()
  })

  it("refuses paths outside this conversation's files", async () => {
    const d = deps()
    const result = await run(T.share, { paths: ["/workspace/../etc"], mode: "snapshot" }, d)
    expect(result.ok).toBe(false)
    expect(d.expandSelection).not.toHaveBeenCalled()
  })

  it("refuses an archived conversation", async () => {
    const d = deps({ getSession: jest.fn(async () => ({ ...session, archivedAt: 5 })) })
    const result = await run(T.share, { paths: ["/workspace"], mode: "live" }, d)
    expect(result).toMatchObject({ ok: false, code: "session_inactive" })
  })

  it("publishes a snapshot of the files, leaving out what holds secrets", async () => {
    const d = deps()
    const result = await run(T.share, { paths: ["/workspace/src"], mode: "snapshot" }, d)
    expect(d.createSnapshotShare).toHaveBeenCalledWith(
      expect.objectContaining({
        ttlSeconds: 7 * 24 * 3600,
        burnAfterRead: false,
        session,
        files: [expect.objectContaining({ path: "/workspace/src/a.ts" })],
        confirmedSensitive: new Set(),
        payload: expect.objectContaining({
          kind: "file-bundle",
          title: "Files from Design review",
        }),
      })
    )
    expect(result).toEqual({
      ok: true,
      mode: "snapshot",
      code: "AbC123",
      url: "https://share.example/s/AbC123#key",
      expiresAt: 5_000,
      files: 1,
      withheldSensitive: 2,
    })
  })

  it("keeps a snapshot within the policy's ceiling", async () => {
    const d = deps({ loadPolicy: jest.fn(async () => policy({ maxSnapshotTtlSeconds: 86_400 })) })
    await run(T.share, { paths: ["/workspace/src"], mode: "snapshot" }, d)
    expect(d.createSnapshotShare).toHaveBeenCalledWith(
      expect.objectContaining({ ttlSeconds: 86_400 })
    )
    const tooLong = await run(
      T.share,
      { paths: ["/workspace/src"], mode: "snapshot", expires_in_seconds: 2 * 86_400 },
      d
    )
    expect(tooLong).toMatchObject({ ok: false, code: "ttl_exceeds_policy" })
  })

  it("shares nothing when every file holds secrets", async () => {
    const d = deps({
      expandSelection: jest.fn(async () => ({
        files: [candidate("/workspace/.env", true)],
        skippedSensitive: 0,
        truncated: false,
        issues: [],
      })),
    })
    const result = await run(T.share, { paths: ["/workspace/.env"], mode: "snapshot" }, d)
    expect(result).toMatchObject({ ok: false, code: "nothing-to-share" })
    expect(d.createSnapshotShare).not.toHaveBeenCalled()
  })

  it("gives live access marked as the agent's, and never returns the password", async () => {
    const d = deps()
    const result = await run(
      T.share,
      { paths: ["/workspace/src"], mode: "live", permissions: ["write"], label: " Review " },
      d
    )
    expect(d.createLiveShare).toHaveBeenCalledWith(
      {
        sessionId: "s1",
        paths: ["/workspace/src"],
        permissions: ["read", "write"],
        protocols: ["webdav"],
        provider: "builtin",
        expiresInSeconds: 24 * 3600,
        createdBy: "agent",
        label: "Review",
      },
      "local"
    )
    expect(result).toMatchObject({
      ok: true,
      mode: "live",
      grantId: "fg_new",
      hostId: "local",
      credentials: [{ credentialId: "fc_fg_new", protocol: "webdav", username: "cg_fg_new" }],
      endpoints: expect.objectContaining({ webdavUrls: ["https://192.168.1.2:27893/"] }),
    })
    expect(JSON.stringify(result)).not.toContain("s3cret-password-never-returned")
  })

  it("starts an SFTPGo share as SFTP only, as the dialog does", async () => {
    const d = deps()
    await run(T.share, { paths: ["/workspace"], mode: "live", provider: "sftpgo" }, d)
    expect(d.createLiveShare).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "sftpgo", protocols: ["sftp"] }),
      "local"
    )
  })

  it("refuses live access to a path that holds secrets", async () => {
    const d = deps()
    const result = await run(T.share, { paths: ["/workspace/.ssh"], mode: "live" }, d)
    expect(result).toMatchObject({ ok: false, code: "sensitive_path" })
    expect(d.createLiveShare).not.toHaveBeenCalled()
  })

  it("passes the host's refusal on with its code", async () => {
    const d = deps({
      createLiveShare: jest.fn(async () => {
        throw Object.assign(new Error("credentials off"), { code: "policy_credentials_disabled" })
      }),
    })
    const result = await run(T.share, { paths: ["/workspace"], mode: "live" }, d)
    expect(result).toEqual({
      ok: false,
      code: "policy_credentials_disabled",
      error: "credentials off",
    })
  })

  describe("audience=members", () => {
    const shared = {
      ...session,
      collaboration: {
        endpoint: "https://collab.test",
        orgId: "org_1",
        workspaceId: "ws_1",
        sessionId: "ses_1",
        policyRevision: 1,
        syncCursor: 0,
      },
    } as ChatSession
    const membersDeps = (patch: Partial<FilespaceToolDeps> = {}) =>
      deps({
        getSession: jest.fn(async () => shared),
        createLiveShare: jest.fn(
          async (request) =>
            ({
              grant: {
                ...grant("fg_members").grant,
                createdBy: "agent",
                protocols: [],
                permissions: request.permissions,
                audience: {
                  kind: "collab",
                  orgId: "org_1",
                  collabSessionId: "ses_1",
                  userIds: null,
                  minRole:
                    request.audience?.kind === "collab" ? request.audience.minRole : "viewer",
                },
              },
              credentials: [],
              endpoints: {
                webdavUrls: [],
                sftp: [],
                sftpHostKeyFingerprint: null,
                tlsFingerprint: null,
                unavailableReason: null,
              },
            }) as CreatedLiveGrant
        ),
        ...patch,
      })

    it("shares with the conversation's members by role, with no protocol and no credentials", async () => {
      const d = membersDeps()
      const result = await run(
        T.share,
        {
          paths: ["/workspace/src"],
          mode: "live",
          audience: "members",
          min_role: "member",
          permissions: ["write"],
          label: "Sources",
        },
        d
      )
      expect(d.createLiveShare).toHaveBeenCalledWith(
        {
          sessionId: "s1",
          paths: ["/workspace/src"],
          permissions: ["read", "write"],
          protocols: [],
          expiresInSeconds: 24 * 3600,
          createdBy: "agent",
          audience: { kind: "collab", minRole: "member" },
          label: "Sources",
        },
        "local"
      )
      expect(result).toEqual({
        ok: true,
        mode: "live",
        audience: "members",
        grantId: "fg_members",
        hostId: "local",
        status: "active",
        minRole: "member",
        permissions: ["read", "write"],
        paths: ["/workspace"],
        expiresAt: 9_000_000,
      })
    })

    it("admits every role from viewer up by default", async () => {
      const d = membersDeps()
      await run(T.share, { paths: ["/workspace"], mode: "live", audience: "members" }, d)
      expect(d.createLiveShare).toHaveBeenCalledWith(
        expect.objectContaining({ audience: { kind: "collab", minRole: "viewer" } }),
        "local"
      )
    })

    it("refuses a conversation nobody else is in", async () => {
      const d = deps()
      const result = await run(
        T.share,
        { paths: ["/workspace"], mode: "live", audience: "members" },
        d
      )
      expect(result).toMatchObject({ ok: false, code: "collab_host_unregistered" })
      expect(d.createLiveShare).not.toHaveBeenCalled()
    })

    it("refuses terms that belong to the other audience", async () => {
      const d = membersDeps()
      for (const args of [
        { audience: "members", protocols: ["webdav"] },
        { audience: "members", provider: "builtin" },
        { audience: "members", min_role: "admin" },
        { audience: "everyone" },
        { min_role: "viewer" },
      ]) {
        const result = await run(T.share, { paths: ["/workspace"], mode: "live", ...args }, d)
        expect(result).toMatchObject({ ok: false })
      }
      expect(d.createLiveShare).not.toHaveBeenCalled()
    })

    it("keeps paths that hold secrets out of a members share too", async () => {
      const d = membersDeps()
      const result = await run(
        T.share,
        { paths: ["/workspace/.ssh"], mode: "live", audience: "members" },
        d
      )
      expect(result).toMatchObject({ ok: false, code: "sensitive_path" })
      expect(d.createLiveShare).not.toHaveBeenCalled()
    })

    it("passes a failed registration on with its code", async () => {
      const d = membersDeps({
        createLiveShare: jest.fn(async () => {
          throw Object.assign(new Error("no"), { code: "shared_session_forbidden" })
        }),
      })
      const result = await run(
        T.share,
        { paths: ["/workspace"], mode: "live", audience: "members" },
        d
      )
      expect(result).toEqual({ ok: false, code: "shared_session_forbidden", error: "no" })
    })
  })
})

describe("filespace_enable_webdav", () => {
  it("shares /workspace over WebDAV by default", async () => {
    const d = deps()
    const result = await run(T.enableWebdav, {}, d)
    expect(d.createLiveShare).toHaveBeenCalledWith(
      expect.objectContaining({
        paths: ["/workspace"],
        permissions: ["read", "download"],
        protocols: ["webdav"],
        createdBy: "agent",
      }),
      "local"
    )
    expect(result.ok).toBe(true)
  })

  it("asks for paths when the conversation has no workspace", async () => {
    const d = deps({
      loadFileSpace: jest.fn(async () => ({
        ...loaded,
        space: { ...space, mounts: space.mounts.filter((mount) => mount.id !== "workspace") },
      })),
    })
    expect(await run(T.enableWebdav, {}, d)).toMatchObject({ ok: false })
    expect(d.createLiveShare).not.toHaveBeenCalled()
  })

  it("re-checks the policy at call time", async () => {
    const d = deps({ loadPolicy: jest.fn(async () => policy({ allowAgentSharing: false })) })
    expect(await run(T.enableWebdav, {}, d)).toMatchObject({ code: "policy_agent_disabled" })
  })
})

describe("filespace_revoke_share", () => {
  it("revokes a link made from this conversation", async () => {
    const d = deps()
    expect(await run(T.revokeShare, { code: "MINE" }, d)).toEqual({
      ok: true,
      revoked: { code: "MINE" },
    })
    expect(d.revokeShareLink).toHaveBeenCalledWith("MINE")
  })

  it("will not revoke a link from another conversation", async () => {
    const d = deps()
    expect(await run(T.revokeShare, { code: "THEIRS" }, d)).toMatchObject({
      ok: false,
      code: "not_found",
    })
    expect(d.revokeShareLink).not.toHaveBeenCalled()
  })

  it("revokes this conversation's live access and nobody else's", async () => {
    const d = deps()
    expect(await run(T.revokeShare, { grant_id: "fg_1" }, d)).toEqual({
      ok: true,
      revoked: { grantId: "fg_1", status: "revoked" },
    })
    expect(d.listLiveGrants).toHaveBeenCalledWith("s1", "local")
    expect(await run(T.revokeShare, { grant_id: "fg_other" }, d)).toMatchObject({
      code: "not_found",
    })
    expect(d.revokeLiveGrant).toHaveBeenCalledTimes(1)
  })

  it("takes exactly one of code and grant_id", async () => {
    expect(await run(T.revokeShare, {}, deps())).toMatchObject({ ok: false })
    expect(await run(T.revokeShare, { code: "A", grant_id: "B" }, deps())).toMatchObject({
      ok: false,
    })
  })
})

describe("filespace_disable_webdav", () => {
  it("revokes every live WebDAV access and names SFTP it ended with it", async () => {
    const d = deps({
      listLiveGrants: jest.fn(async () => [
        grant("fg_dav"),
        grant("fg_both", { protocols: ["webdav", "sftp"] }),
        grant("fg_sftp", { protocols: ["sftp"] }),
        grant("fg_gone", { status: "revoked" }),
      ]),
    })
    expect(await run(T.disableWebdav, {}, d)).toEqual({
      ok: true,
      revoked: ["fg_dav", "fg_both"],
      alsoEndedSftp: ["fg_both"],
    })
  })

  it("reports what it could not revoke", async () => {
    const d = deps({
      revokeLiveGrant: jest.fn(async () => {
        throw Object.assign(new Error("x"), { code: "store_failed" })
      }),
    })
    expect(await run(T.disableWebdav, {}, d)).toMatchObject({
      ok: false,
      revoked: [],
      failed: [{ grantId: "fg_1", code: "store_failed" }],
    })
  })
})
