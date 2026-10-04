import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"
import { messageRepository } from "./plugin-bridge"
import {
  invalidateTranscriptRuntime,
  withTranscriptRuntimeLock,
} from "@/lib/chat/transcript/revision-events"

jest.mock("@/lib/chat/transcript/revision-events", () => ({
  ...jest.requireActual("@/lib/chat/transcript/revision-events"),
  invalidateTranscriptRuntime: jest.fn(async () => {}),
}))
jest.mock("@/lib/platform/detect", () => ({ isTauri: () => false }))

const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
afterAll(fixture.dispose)
beforeEach(async () => {
  await fixture.restore()
  jest.mocked(invalidateTranscriptRuntime).mockReset().mockResolvedValue(undefined)
  await getDb().sessions.put({ id: "s1", title: "Test", createdAt: 1, updatedAt: 1 } as never)
  await getDb().messages.put({
    id: "m1",
    sessionId: "s1",
    role: "user",
    parts: [{ type: "text", text: "original" }],
    createdAt: 1,
  })
})

it("invalidates the provider context for remote/plugin edits and deletions", async () => {
  await messageRepository.update("m1", { content: "corrected" })
  expect(invalidateTranscriptRuntime).toHaveBeenCalledWith("s1")
  expect((await getDb().messages.get("m1"))?.parts).toEqual([{ type: "text", text: "corrected" }])
  await messageRepository.delete("m1")
  expect(invalidateTranscriptRuntime).toHaveBeenCalledTimes(2)
})

it("leaves rows unchanged if runtime close fails", async () => {
  jest.mocked(invalidateTranscriptRuntime).mockRejectedValue(new Error("host unavailable"))
  await expect(messageRepository.update("m1", { content: "corrected" })).rejects.toThrow(
    "host unavailable"
  )
  await expect(messageRepository.delete("m1")).rejects.toThrow("host unavailable")
  await expect(messageRepository.deleteBySessionId("s1")).rejects.toThrow("host unavailable")
  expect((await getDb().messages.get("m1"))?.parts).toEqual([{ type: "text", text: "original" }])
})

it("does not interrupt a live turn for append or display metadata updates", async () => {
  await messageRepository.update("m1", { tokens: 12 } as never)
  await messageRepository.create("s1", { id: "m2", role: "user", content: "next" } as never)
  expect(invalidateTranscriptRuntime).not.toHaveBeenCalled()
})

it("keeps reconstruction behind the entire remote deletion, including its database commit", async () => {
  let releaseClose!: () => void
  let enteredClose!: () => void
  const entered = new Promise<void>((resolve) => {
    enteredClose = resolve
  })
  jest.mocked(invalidateTranscriptRuntime).mockImplementationOnce(async () => {
    enteredClose()
    await new Promise<void>((resolve) => {
      releaseClose = resolve
    })
  })
  const deletion = messageRepository.delete("m1")
  await entered
  const hydrate = jest.fn(async () => getDb().messages.where("sessionId").equals("s1").toArray())
  const send = withTranscriptRuntimeLock("s1", hydrate)
  await Promise.resolve()
  await Promise.resolve()
  expect(hydrate).not.toHaveBeenCalled()
  releaseClose()
  await deletion
  await expect(send).resolves.toEqual([])
})
