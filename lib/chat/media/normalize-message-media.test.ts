import type { UIMessage } from "ai"
import type { StoredMessage } from "@cognia/agent-config-types"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { isMediaRef } from "@/lib/db/message-media"
import { normalizeMessageMedia, normalizeStoredMessageMedia } from "./normalize-message-media"

jest.setTimeout(30_000)

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

function message(parts: UIMessage["parts"]): UIMessage {
  return { id: "m1", role: "user", parts }
}

describe("normalizeMessageMedia", () => {
  it("moves image data URLs out of message parts into the media store", async () => {
    const source = message([
      {
        type: "file",
        url: "data:image/png;base64,aGVsbG8=",
        mediaType: "image/png",
        filename: "hello.png",
      },
    ] as UIMessage["parts"])

    const normalized = await normalizeMessageMedia(source)
    const part = normalized.parts[0] as {
      url: string
      mediaType: string
      filename: string
      byteSize?: number
    }

    expect(normalized).not.toBe(source)
    expect(isMediaRef(part.url)).toBe(true)
    expect(part).toMatchObject({
      mediaType: "image/png",
      filename: "hello.png",
      byteSize: 5,
    })
    expect(await getDb().messageMedia.count()).toBe(1)
  })

  it("keeps a video's descriptor on the frame it ingests", async () => {
    // The transcript's video card is built from this field; losing it at the
    // persistence boundary would scatter a storyboard back into loose images.
    const videoAttachment = { groupId: "v1", filename: "demo.mp4", delivery: "storyboard" }
    const source = message([
      {
        type: "file",
        url: "data:image/jpeg;base64,aGVsbG8=",
        mediaType: "image/jpeg",
        filename: "demo.mp4",
        videoAttachment,
      },
    ] as unknown as UIMessage["parts"])

    const normalized = await normalizeMessageMedia(source)
    const part = normalized.parts[0] as { url: string; videoAttachment?: unknown }
    expect(isMediaRef(part.url)).toBe(true)
    expect(part.videoAttachment).toEqual(videoAttachment)
  })

  it("preserves object identity when no image data URL needs ingestion", async () => {
    const remote = message([
      { type: "file", url: "https://example.com/a.png", mediaType: "image/png" },
      { type: "text", text: "hello" },
    ] as UIMessage["parts"])

    await expect(normalizeMessageMedia(remote)).resolves.toBe(remote)
  })

  it("does not treat non-image data URLs as image media", async () => {
    const document = message([
      { type: "file", url: "data:text/plain;base64,aGVsbG8=", mediaType: "text/plain" },
    ] as UIMessage["parts"])

    await expect(normalizeMessageMedia(document)).resolves.toBe(document)
    expect(await getDb().messageMedia.count()).toBe(0)
  })

  it("normalizes stored rows without dropping database-only columns", async () => {
    const stored: StoredMessage = {
      id: "stored-1",
      sessionId: "session-1",
      role: "assistant",
      parts: [
        {
          type: "file",
          url: "data:image/png;base64,aGVsbG8=",
          mediaType: "image/png",
        },
      ] as StoredMessage["parts"],
      platformMessageId: "platform-1",
      createdAt: 123,
    }

    const normalized = await normalizeStoredMessageMedia(stored)
    const file = normalized.parts[0] as { url: string }

    expect(isMediaRef(file.url)).toBe(true)
    expect(normalized).toMatchObject({
      id: "stored-1",
      sessionId: "session-1",
      platformMessageId: "platform-1",
      createdAt: 123,
    })
  })
})
