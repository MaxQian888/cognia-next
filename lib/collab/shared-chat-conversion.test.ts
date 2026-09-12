import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import {
  SharedChatTeamSessionUnsupportedError,
  convertLocalSessionToShared,
  resolveSharedAttachmentParts,
} from "./shared-chat-conversion"

jest.mock("@/lib/db/schema", () => {
  const actual = jest.requireActual("@/lib/db/schema")
  return { ...actual, getDb: jest.fn(actual.getDb) }
})

const dbFixture = createDbTestFixture()

describe("shared attachment downloads", () => {
  const parts = [
    { type: "file" as const, mediaType: "text/plain", url: "cognia://shared-attachment/file" },
  ]
  function clientFor(patch = {}) {
    return {
      createSessionAttachmentDownloadTicket: jest.fn().mockResolvedValue({
        attachment: {
          id: "file",
          sessionId: "session",
          status: "available",
          mediaType: "text/plain",
          byteLength: 5,
          sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
          ...patch,
        },
        ticket: "single-use-header",
      }),
      downloadSessionAttachment: jest.fn().mockResolvedValue(new Blob(["hello"])),
    }
  }
  it("uses an authenticated ticket and checks bytes before returning renderable parts", async () => {
    const client = clientFor()
    expect(await resolveSharedAttachmentParts(client, "org", "session", parts)).toEqual([
      { ...parts[0], url: "data:text/plain;base64,aGVsbG8=" },
    ])
    expect(client.downloadSessionAttachment).toHaveBeenCalledWith(
      "org",
      "file",
      "single-use-header"
    )
  })
  it.each([{ id: "other" }, { sessionId: "other" }, { orgId: "other" }, { status: "deleted" }])(
    "rejects mismatched attachment scope %j",
    async (patch) => {
      const client = clientFor(patch)
      await expect(resolveSharedAttachmentParts(client, "org", "session", parts)).rejects.toThrow(
        "scope mismatch"
      )
      expect(client.downloadSessionAttachment).not.toHaveBeenCalled()
    }
  )
  it.each([{ byteLength: 9 }, { sha256: "0".repeat(64) }])(
    "rejects corrupt attachment bytes %j",
    async (patch) => {
      await expect(
        resolveSharedAttachmentParts(clientFor(patch), "org", "session", parts)
      ).rejects.toThrow("integrity mismatch")
    }
  )
  it("preserves ordinary text and inline files without issuing tickets", async () => {
    const client = clientFor()
    const normal = [
      { type: "text" as const, text: "hello" },
      { ...parts[0], url: "data:text/plain;base64,aA==" },
    ]
    expect(await resolveSharedAttachmentParts(client, "org", "session", normal)).toEqual(normal)
    expect(client.createSessionAttachmentDownloadTicket).not.toHaveBeenCalled()
  })
})

describe("local-to-shared chat conversion", () => {
  beforeAll(dbFixture.initialize)
  beforeEach(async () => {
    await dbFixture.restore()
    await getDb().sessions.put({
      id: "local_1",
      projectId: "workspace_1",
      title: "Private history",
      kind: "direct",
      createdAt: 1,
      updatedAt: 2,
    })
    await getDb().messages.bulkPut([
      {
        id: "message_1",
        sessionId: "local_1",
        projectId: "workspace_1",
        role: "user",
        parts: [{ type: "text", text: "hello" }],
        createdAt: 3,
      },
      {
        id: "message_2",
        sessionId: "local_1",
        projectId: "workspace_1",
        role: "assistant",
        parts: [{ type: "text", text: "hi" }],
        createdAt: 4,
      },
    ])
  })
  afterAll(dbFixture.dispose)

  it("binds the local session only after every event and activation succeed", async () => {
    let sequence = 0
    const client = {
      identity: jest.fn().mockResolvedValue({ userId: "user_1", orgId: "org_1" }),
      createSharedSession: jest.fn().mockResolvedValue({
        id: "shared_1",
        orgId: "org_1",
        workspaceId: "workspace_1",
        title: "Private history",
        status: "importing",
        createdBy: { kind: "human", id: "user_1" },
        createdAt: 10,
        updatedAt: 10,
        revision: 1,
        policyRevision: 1,
      }),
      appendSessionEvent: jest.fn(async (_orgId, sessionId, input) => ({
        id: `event_${++sequence}`,
        sessionId,
        sequence,
        kind: input.kind,
        actor: { kind: "human" as const, id: "user_1" },
        payload: input.payload,
        createdAt: 10 + sequence,
        operationId: input.operationId,
      })),
      updateSharedSession: jest.fn().mockImplementation(async (_orgId, _sessionId, input) => ({
        id: "shared_1",
        orgId: "org_1",
        workspaceId: "workspace_1",
        title: "Private history",
        status: input.status,
        createdBy: { kind: "human", id: "user_1" },
        createdAt: 10,
        updatedAt: 20,
        revision: 2,
        policyRevision: 2,
      })),
    }

    const result = await convertLocalSessionToShared(client, {
      localSessionId: "local_1",
      orgId: "org_1",
      workspaceId: "workspace_1",
    })

    expect(client.createSharedSession).toHaveBeenCalledWith("org_1", "workspace_1", {
      title: "Private history",
      importing: true,
      operationId: "chat-import:local_1:create",
    })
    expect(client.appendSessionEvent).toHaveBeenCalledTimes(2)
    expect(client.updateSharedSession).toHaveBeenCalledWith("org_1", "shared_1", {
      status: "active",
      operationId: "chat-import:local_1:activate",
      baseRevision: 1,
    })
    expect(result.importedMessageCount).toBe(2)
    expect((await getDb().sessions.get("local_1"))?.collaboration).toEqual({
      orgId: "org_1",
      workspaceId: "workspace_1",
      sessionId: "shared_1",
      policyRevision: 2,
      syncCursor: 2,
    })
  })

  it("leaves the private session untouched when remote import fails", async () => {
    const client = {
      identity: jest.fn().mockResolvedValue({ userId: "user_1", orgId: "org_1" }),
      createSharedSession: jest.fn().mockResolvedValue({
        id: "shared_draft",
        orgId: "org_1",
        workspaceId: "workspace_1",
        title: "Private history",
        status: "importing",
        createdBy: { kind: "human", id: "user_1" },
        createdAt: 10,
        updatedAt: 10,
        revision: 1,
        policyRevision: 1,
      }),
      appendSessionEvent: jest.fn().mockRejectedValue(new Error("upload failed")),
      updateSharedSession: jest.fn(),
    }

    await expect(
      convertLocalSessionToShared(client, {
        localSessionId: "local_1",
        orgId: "org_1",
        workspaceId: "workspace_1",
      })
    ).rejects.toThrow("upload failed")

    expect((await getDb().sessions.get("local_1"))?.collaboration).toBeUndefined()
    expect(client.updateSharedSession).not.toHaveBeenCalled()
  })

  it("refuses a character-team room before it creates anything on the server", async () => {
    // Converting one left `kind: "team"` and `teamId` on the row beside the
    // new `collaboration` block, so the session became two things at once:
    // `useTeamChat` kept writing replies straight to Dexie while the sync
    // pulled the server's events into the same list, and nobody outside ever
    // saw the room answer. Refusing is the honest outcome until a shared
    // session can carry a team.
    await getDb().sessions.put({
      id: "local_team",
      projectId: "workspace_1",
      title: "Doc Polishers",
      kind: "team",
      teamId: "team_1",
      createdAt: 1,
      updatedAt: 2,
    })
    const client = {
      identity: jest.fn(),
      createSharedSession: jest.fn(),
      appendSessionEvent: jest.fn(),
      updateSharedSession: jest.fn(),
    }

    await expect(
      convertLocalSessionToShared(client as never, {
        localSessionId: "local_team",
        orgId: "org_1",
        workspaceId: "workspace_1",
      })
    ).rejects.toThrow(SharedChatTeamSessionUnsupportedError)

    expect(client.createSharedSession).not.toHaveBeenCalled()
    expect((await getDb().sessions.get("local_team"))?.collaboration).toBeUndefined()
  })
})

describe("attachment reads are guarded", () => {
  const dbFixture = createDbTestFixture()

  beforeAll(dbFixture.initialize)
  beforeEach(async () => {
    await dbFixture.restore()
    await getDb().sessions.put({
      id: "local_1",
      projectId: "workspace_1",
      title: "Imported history",
      kind: "direct",
      createdAt: 1,
      updatedAt: 2,
    })
  })
  afterAll(dbFixture.dispose)

  function clientWithAttachments() {
    return {
      identity: jest.fn().mockResolvedValue({ userId: "user_1", orgId: "org_1" }),
      createSharedSession: jest.fn().mockResolvedValue({
        id: "shared_1",
        orgId: "org_1",
        workspaceId: "workspace_1",
        title: "Imported history",
        status: "importing",
        createdBy: { kind: "human", id: "user_1" },
        createdAt: 10,
        updatedAt: 10,
        revision: 1,
        policyRevision: 1,
      }),
      appendSessionEvent: jest
        .fn()
        .mockResolvedValue({ id: "event_1", sequence: 1, createdAt: 11 }),
      updateSharedSession: jest.fn().mockResolvedValue({
        id: "shared_1",
        orgId: "org_1",
        workspaceId: "workspace_1",
        title: "Imported history",
        status: "active",
        createdBy: { kind: "human", id: "user_1" },
        createdAt: 10,
        updatedAt: 20,
        revision: 2,
        policyRevision: 2,
      }),
      initializeSessionAttachment: jest
        .fn()
        .mockResolvedValue({ attachment: { id: "att_1" }, ticket: "ticket" }),
      uploadSessionAttachment: jest.fn().mockResolvedValue(undefined),
      commitSessionAttachment: jest.fn().mockResolvedValue(undefined),
      listSessionEvents: jest.fn().mockResolvedValue([]),
    }
  }

  async function putFileMessage(url: string) {
    await getDb().messages.put({
      id: "message_1",
      sessionId: "local_1",
      projectId: "workspace_1",
      role: "user",
      parts: [{ type: "file", url, mediaType: "image/png", filename: "shot.png" }],
      createdAt: 3,
    })
  }

  it.each(["activation", "attachment-commit"])(
    "reuses durable attachment references after an uncertain %s response",
    async (failure) => {
      await putFileMessage("data:image/png;base64,AQID")
      const client = clientWithAttachments()
      const draft = await client.createSharedSession()
      const active = await client.updateSharedSession()
      client.createSharedSession.mockClear()
      client.updateSharedSession.mockClear()
      let published: import("@cognia/agent-config-types").SessionEvent | undefined
      client.appendSessionEvent.mockImplementation(async (_org, sessionId, input) => {
        published = {
          id: "event_1",
          sessionId,
          sequence: 1,
          kind: input.kind,
          actor: { kind: "human", id: "user_1" },
          payload: input.payload,
          createdAt: 11,
          operationId: input.operationId,
        }
        return published
      })
      client.listSessionEvents.mockImplementation(async (_org, _session, cursor) =>
        published && cursor === 0 ? [published] : []
      )
      if (failure === "activation") {
        client.updateSharedSession.mockImplementationOnce(async () => {
          client.createSharedSession.mockResolvedValue(active)
          throw new Error("activation response lost")
        })
      } else {
        client.commitSessionAttachment.mockRejectedValueOnce(new Error("commit response lost"))
      }
      const input = {
        localSessionId: "local_1",
        orgId: "org_1",
        workspaceId: "workspace_1",
        readAttachment: async () => new Uint8Array([1, 2, 3]),
      }
      await expect(convertLocalSessionToShared(client, input)).rejects.toThrow("response lost")
      expect((await getDb().sessions.get("local_1"))?.collaboration).toBeUndefined()
      await expect(convertLocalSessionToShared(client, input)).resolves.toMatchObject({
        session: active,
      })
      expect(client.initializeSessionAttachment).toHaveBeenCalledTimes(1)
      expect(client.uploadSessionAttachment).toHaveBeenCalledTimes(1)
      expect(client.appendSessionEvent).toHaveBeenCalledTimes(1)
      expect(published?.payload.parts).toEqual([
        expect.objectContaining({ url: "cognia://shared-attachment/att_1" }),
      ])
      expect(client.commitSessionAttachment).toHaveBeenLastCalledWith(
        "org_1",
        draft.id,
        "att_1",
        "event_1"
      )
      expect(client.updateSharedSession).toHaveBeenCalledTimes(1)
      expect((await getDb().sessions.get("local_1"))?.collaboration?.sessionId).toBe(draft.id)
    }
  )

  it.each(["foreign-session", "gap", "message-id", "role", "parts"])(
    "refuses incompatible durable import history: %s",
    async (mismatch) => {
      await putFileMessage("data:image/png;base64,AQID")
      const client = clientWithAttachments()
      client.listSessionEvents.mockResolvedValueOnce([
        {
          id: "event_1",
          sessionId: mismatch === "foreign-session" ? "other" : "shared_1",
          sequence: mismatch === "gap" ? 2 : 1,
          kind: "message.created",
          actor: { kind: "human", id: "user_1" },
          operationId: "chat-import:local_1:message:message_1",
          createdAt: 11,
          payload: {
            imported: true,
            messageId: mismatch === "message-id" ? "other" : "message_1",
            role: mismatch === "role" ? "assistant" : "user",
            parts: mismatch === "parts" ? null : [],
          },
        },
      ])
      await expect(
        convertLocalSessionToShared(client, {
          localSessionId: "local_1",
          orgId: "org_1",
          workspaceId: "workspace_1",
        })
      ).rejects.toThrow(/history/)
      expect(client.initializeSessionAttachment).not.toHaveBeenCalled()
      expect((await getDb().sessions.get("local_1"))?.collaboration).toBeUndefined()
    }
  )

  it("requires durable history before recovering an already activated import", async () => {
    await putFileMessage("data:image/png;base64,AQID")
    const client = clientWithAttachments()
    client.createSharedSession.mockResolvedValue(await client.updateSharedSession())
    const { listSessionEvents: _history, ...legacyClient } = client
    await expect(
      convertLocalSessionToShared(legacyClient, {
        localSessionId: "local_1",
        orgId: "org_1",
        workspaceId: "workspace_1",
      })
    ).rejects.toThrow("recovery requires event history")
    expect(client.initializeSessionAttachment).not.toHaveBeenCalled()
  })

  // `part.url` comes from whatever a foreign transcript carried — the external
  // agent importers write it verbatim. Fetching it would make the authenticated
  // webview reach an attacker-chosen host and upload the response.
  it("refuses to fetch a loopback attachment URL", async () => {
    await putFileMessage("http://127.0.0.1:9999/secret")
    const fetchSpy = jest.spyOn(globalThis, "fetch")

    await expect(
      convertLocalSessionToShared(clientWithAttachments(), {
        localSessionId: "local_1",
        orgId: "org_1",
        workspaceId: "workspace_1",
      })
    ).rejects.toThrow(/private\/loopback/)

    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  // `data:`/`blob:` resolve in-process and reach no network, so the guard must
  // not stand in their way — they are what a locally-attached file actually is.
  it("lets a data: attachment through to the reader", async () => {
    await putFileMessage("data:image/png;base64,AAAA")
    const readAttachment = jest.fn().mockResolvedValue(new Uint8Array([1, 2, 3]))

    await convertLocalSessionToShared(clientWithAttachments(), {
      localSessionId: "local_1",
      orgId: "org_1",
      workspaceId: "workspace_1",
      readAttachment,
    }).catch(() => undefined)

    expect(readAttachment).toHaveBeenCalled()
  })

  it("keeps local media renderable and atomically caches namespaced server events", async () => {
    const url = "data:image/png;base64,AQID"
    await putFileMessage(url)
    const client = { ...clientWithAttachments(), baseUrl: "https://collab.example/" }
    const result = await convertLocalSessionToShared(client, {
      localSessionId: "local_1",
      orgId: "org_1",
      workspaceId: "workspace_1",
      readAttachment: async () => new Uint8Array([1, 2, 3]),
    })
    expect(result.importedAttachmentCount).toBe(1)
    expect(client.appendSessionEvent.mock.calls[0][2].payload.parts[0].url).toBe(
      "cognia://shared-attachment/att_1"
    )
    expect((await getDb().messages.get("message_1"))?.parts[0]).toMatchObject({ url })
    expect(client.commitSessionAttachment).toHaveBeenCalledWith(
      "org_1",
      "shared_1",
      "att_1",
      "event_1"
    )
    expect(await getDb().collabChatEvents.toArray()).toEqual([
      expect.objectContaining({
        id: '["https://collab.example","org_1","shared_1"]:event:event_1',
        sessionId: '["https://collab.example","org_1","shared_1"]',
      }),
    ])
  })

  it("retains extracted text and already shared attachments without reading bytes", async () => {
    const parts = [
      { type: "file", filename: "notes.txt", mediaType: "text/plain", text: "extracted text" },
      { type: "file", mediaType: "image/png", url: "cognia://shared-attachment/existing" },
    ] as unknown as import("@cognia/agent-config-types").StoredMessage["parts"]
    await getDb().messages.put({
      id: "message_1",
      sessionId: "local_1",
      projectId: "workspace_1",
      role: "user",
      parts,
      createdAt: 3,
    })
    const client = clientWithAttachments()
    const readAttachment = jest.fn()
    await convertLocalSessionToShared(client, {
      localSessionId: "local_1",
      orgId: "org_1",
      workspaceId: "workspace_1",
      readAttachment,
    })
    expect(readAttachment).not.toHaveBeenCalled()
    expect(client.initializeSessionAttachment).not.toHaveBeenCalled()
    expect(client.appendSessionEvent.mock.calls[0][2].payload.parts).toEqual(parts)
  })

  it("does not bind or cache events when attachment commit is uncertain", async () => {
    await putFileMessage("data:image/png;base64,AQID")
    const client = clientWithAttachments()
    client.commitSessionAttachment.mockRejectedValue(new Error("connection lost"))
    await expect(
      convertLocalSessionToShared(client, {
        localSessionId: "local_1",
        orgId: "org_1",
        workspaceId: "workspace_1",
        readAttachment: async () => new Uint8Array([1, 2, 3]),
      })
    ).rejects.toThrow("connection lost")
    expect((await getDb().sessions.get("local_1"))?.collaboration).toBeUndefined()
    expect(await getDb().collabChatEvents.count()).toBe(0)
    expect(client.updateSharedSession).not.toHaveBeenCalled()
  })

  it.each(["missing", "shared"])(
    "rejects a %s source before creating a remote session",
    async (state) => {
      if (state === "missing") await getDb().sessions.delete("local_1")
      else
        await getDb().sessions.update("local_1", {
          collaboration: {
            orgId: "org_1",
            workspaceId: "workspace_1",
            sessionId: "existing",
            policyRevision: 1,
            syncCursor: 0,
          },
        })
      const client = clientWithAttachments()
      await expect(
        convertLocalSessionToShared(client, {
          localSessionId: "local_1",
          orgId: "org_1",
          workspaceId: "workspace_1",
        })
      ).rejects.toThrow(state === "missing" ? "does not exist" : "already shared")
      expect(client.createSharedSession).not.toHaveBeenCalled()
    }
  )

  it("requires an attachment transport before creating an import", async () => {
    await putFileMessage("data:image/png;base64,AQID")
    const client = { ...clientWithAttachments(), initializeSessionAttachment: undefined }
    await expect(
      convertLocalSessionToShared(client, {
        localSessionId: "local_1",
        orgId: "org_1",
        workspaceId: "workspace_1",
      })
    ).rejects.toThrow("attachment importer")
    expect(client.createSharedSession).not.toHaveBeenCalled()
  })

  it("supports an explicit attachment importer", async () => {
    await putFileMessage("data:image/png;base64,AQID")
    const client = clientWithAttachments()
    const parts = [{ type: "text" as const, text: "verified extracted attachment" }]
    await convertLocalSessionToShared(client, {
      localSessionId: "local_1",
      orgId: "org_1",
      workspaceId: "workspace_1",
      prepareAttachmentParts: async () => parts,
    })
    expect(client.appendSessionEvent.mock.calls[0][2].payload.parts).toEqual(parts)
    expect(client.initializeSessionAttachment).not.toHaveBeenCalled()
  })

  it.each([true, false])("resolves local media only when its bytes exist: %s", async (exists) => {
    await putFileMessage("cognia-media:hash")
    if (exists)
      await getDb().messageMedia.put({
        hash: "hash",
        mediaType: "image/png",
        width: 1,
        height: 1,
        byteSize: 3,
        blob: new Blob([new Uint8Array([1, 2, 3])]),
        createdAt: 1,
        lastUsedAt: 1,
      })
    const client = clientWithAttachments()
    const result = convertLocalSessionToShared(client, {
      localSessionId: "local_1",
      orgId: "org_1",
      workspaceId: "workspace_1",
    })
    if (exists) {
      await expect(result).resolves.toMatchObject({ importedAttachmentCount: 1 })
      expect(client.uploadSessionAttachment).toHaveBeenCalledWith(
        "org_1",
        "att_1",
        "ticket",
        new Uint8Array([1, 2, 3])
      )
    } else await expect(result).rejects.toThrow("could not be read")
  })

  it.each([true, false])("validates attachment fetch success: %s", async (ok) => {
    await putFileMessage("https://example.com/image.png")
    const fetchSpy = jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { status: ok ? 200 : 404 }))
    try {
      const result = convertLocalSessionToShared(clientWithAttachments(), {
        localSessionId: "local_1",
        orgId: "org_1",
        workspaceId: "workspace_1",
      })
      if (ok) await expect(result).resolves.toMatchObject({ importedAttachmentCount: 1 })
      else await expect(result).rejects.toThrow("could not be read")
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it("preserves existing author identity and system provenance", async () => {
    await getDb().messages.bulkPut([
      {
        id: "system",
        sessionId: "local_1",
        projectId: "workspace_1",
        role: "system",
        parts: [],
        createdAt: 1,
      },
      {
        id: "agent",
        sessionId: "local_1",
        projectId: "workspace_1",
        role: "assistant",
        senderId: "named-agent",
        parts: [],
        createdAt: 2,
      },
      {
        id: "human",
        sessionId: "local_1",
        projectId: "workspace_1",
        role: "user",
        senderId: "named-human",
        parts: [],
        createdAt: 3,
      },
      {
        id: "attributed",
        sessionId: "local_1",
        projectId: "workspace_1",
        role: "user",
        parts: [],
        createdAt: 4,
        collaboration: {
          author: { kind: "human", id: "original", displayName: "Original" },
          sourceEventId: "old",
          eventSequence: 1,
          version: 1,
        },
      },
    ])
    const client = clientWithAttachments()
    await convertLocalSessionToShared(client, {
      localSessionId: "local_1",
      orgId: "org_1",
      workspaceId: "workspace_1",
    })
    expect(client.appendSessionEvent.mock.calls.map((call) => call[2].payload.author.id)).toEqual([
      "system",
      "named-agent",
      "named-human",
      "original",
    ])
  })

  it.each(["identity", "attachment", "upload", "event"])(
    "fences account changes during %s before the next remote write",
    async (stage) => {
      await putFileMessage("data:image/png;base64,AQID")
      const sourceDb = getDb()
      const switchAccount = () => jest.mocked(getDb).mockReturnValue({} as typeof sourceDb)
      const client = clientWithAttachments()
      const readAttachment = async () => {
        if (stage === "attachment") switchAccount()
        return new Uint8Array([1, 2, 3])
      }
      if (stage === "identity")
        client.identity.mockImplementation(async () => {
          switchAccount()
          return { userId: "user_1", orgId: "org_1" }
        })
      if (stage === "upload")
        client.uploadSessionAttachment.mockImplementation(async () => {
          switchAccount()
        })
      if (stage === "event")
        client.appendSessionEvent.mockImplementation(async () => {
          switchAccount()
          return { id: "event_1", sequence: 1, createdAt: 11 }
        })
      try {
        await expect(
          convertLocalSessionToShared(client, {
            localSessionId: "local_1",
            orgId: "org_1",
            workspaceId: "workspace_1",
            readAttachment,
          })
        ).rejects.toMatchObject({ name: "AbortError" })
        expect(client.updateSharedSession).not.toHaveBeenCalled()
        expect(client.commitSessionAttachment).not.toHaveBeenCalled()
        if (stage === "identity") expect(client.createSharedSession).not.toHaveBeenCalled()
        if (stage === "attachment")
          expect(client.initializeSessionAttachment).not.toHaveBeenCalled()
      } finally {
        jest.mocked(getDb).mockImplementation(jest.requireActual("@/lib/db/schema").getDb)
      }
      expect((await sourceDb.sessions.get("local_1"))?.collaboration).toBeUndefined()
    }
  )
})
