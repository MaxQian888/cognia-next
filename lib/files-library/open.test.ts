import type { ChatSession } from "@cognia/agent-config-types"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useChatStore } from "@/stores/chat"
import { useUIStore } from "@/stores/ui"
import { goToSession, openArtifactInSession, openFilesEntry, openTargetFor } from "./open"
import type { FilesEntry } from "./types"

jest.setTimeout(30_000)
const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(async () => {
  await fixture.restore()
  await getDb().sessions.put({
    id: "s1",
    title: "s1",
    createdAt: 1,
    updatedAt: 1,
    kind: "team",
    teamId: "t1",
  } as ChatSession)
})
afterAll(fixture.dispose)

function entry(overrides: Partial<FilesEntry> & Pick<FilesEntry, "kind" | "sourceId">): FilesEntry {
  return {
    key: `${overrides.kind}:${overrides.sourceId}`,
    title: "",
    projectIds: [],
    sessionIds: [],
    originAlive: true,
    createdAt: 1,
    updatedAt: 1,
    ownedByFiles: false,
    hidden: false,
    searchText: "",
    ...overrides,
  }
}

describe("openTargetFor", () => {
  it("routes by kind and whether the conversation is alive", () => {
    expect(openTargetFor(entry({ kind: "canvas", sourceId: "c" }))).toBe("canvas")
    expect(openTargetFor(entry({ kind: "artifact", sourceId: "a", originSessionId: "s1" }))).toBe(
      "artifact"
    )
    expect(
      openTargetFor(
        entry({ kind: "artifact", sourceId: "a", originSessionId: "s1", originAlive: false })
      )
    ).toBe("preview")
    expect(openTargetFor(entry({ kind: "image", sourceId: "h" }))).toBe("preview")
  })
})

describe("openFilesEntry", () => {
  it("opens a canvas document in the Canvas guild", async () => {
    const push = jest.fn()
    const setActiveCanvas = jest.spyOn(useArtifactStore.getState(), "setActiveCanvas")
    await expect(openFilesEntry(entry({ kind: "canvas", sourceId: "c1" }), { push })).resolves.toBe(
      "canvas"
    )
    expect(setActiveCanvas).toHaveBeenCalledWith("c1")
    expect(useUIStore.getState().selectedGuild).toEqual({ kind: "canvas" })
    expect(push).toHaveBeenCalledWith("/")
  })

  it("opens an artifact in its live conversation's panel", async () => {
    const push = jest.fn()
    const setActiveArtifact = jest.spyOn(useArtifactStore.getState(), "setActiveArtifact")
    const openPanel = jest.spyOn(useArtifactStore.getState(), "openPanel")
    await expect(
      openFilesEntry(entry({ kind: "artifact", sourceId: "a1", originSessionId: "s1" }), { push })
    ).resolves.toBe("artifact")
    expect(useChatStore.getState().activeSessionId).toBe("s1")
    expect(useUIStore.getState().selectedGuild).toEqual({ kind: "team", teamId: "t1" })
    expect(setActiveArtifact).toHaveBeenCalledWith("a1", "s1")
    expect(openPanel).toHaveBeenCalledWith("artifact")
    expect(push).toHaveBeenCalledWith("/")
  })

  it("previews in place when the conversation vanished or the kind has no surface", async () => {
    const push = jest.fn()
    await expect(
      openFilesEntry(entry({ kind: "artifact", sourceId: "a1", originSessionId: "gone" }), { push })
    ).resolves.toBe("preview")
    await expect(openFilesEntry(entry({ kind: "upload", sourceId: "u" }), { push })).resolves.toBe(
      "preview"
    )
    expect(push).not.toHaveBeenCalled()
  })
})

describe("openArtifactInSession", () => {
  it("opens the artifact in its conversation, or reports the conversation gone", async () => {
    const push = jest.fn()
    const setActiveArtifact = jest.spyOn(useArtifactStore.getState(), "setActiveArtifact")
    await expect(openArtifactInSession("a2", "s1", { push })).resolves.toBe(true)
    expect(setActiveArtifact).toHaveBeenCalledWith("a2", "s1")
    expect(push).toHaveBeenCalledWith("/")
    push.mockClear()
    await expect(openArtifactInSession("a2", "gone", { push })).resolves.toBe(false)
    expect(push).not.toHaveBeenCalled()
  })
})

describe("goToSession", () => {
  it("focuses the conversation and leaves Files", async () => {
    const push = jest.fn()
    await goToSession("s1", { push })
    expect(useChatStore.getState().activeSessionId).toBe("s1")
    expect(push).toHaveBeenCalledWith("/")
  })
})
