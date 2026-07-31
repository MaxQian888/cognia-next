import type { UIMessage } from "ai"

jest.mock("@/lib/db/messages", () => ({ listMessages: jest.fn() }))

import { promoteLegToPane } from "./promote-to-pane"
import { useChatStore } from "@/stores/chat"
import { listMessages } from "@/lib/db/messages"

const listMock = listMessages as jest.MockedFunction<typeof listMessages>

const uiMsg = (id: string): UIMessage =>
  ({ id, role: "assistant", parts: [{ type: "text", text: "hi" }] }) as UIMessage

beforeEach(() => {
  useChatStore.getState().clear()
  listMock.mockReset()
})

describe("promoteLegToPane", () => {
  it("opens, focuses, and seeds the session slice from Dexie", async () => {
    listMock.mockResolvedValue([uiMsg("m1")])
    const res = await promoteLegToPane("s1")
    expect(res.seeded).toBe(true)
    expect(listMock).toHaveBeenCalledWith("s1")
    const st = useChatStore.getState()
    expect(st.activeSessionId).toBe("s1")
    expect(st.openSessionIds).toContain("s1")
    expect(st.sessions.s1.messages.map((m) => m.id)).toEqual(["m1"])
  })

  it("still opens the pane but records a load error when the Dexie read fails", async () => {
    listMock.mockRejectedValue(new Error("db down"))
    const res = await promoteLegToPane("s2")
    expect(res.seeded).toBe(false)
    const st = useChatStore.getState()
    expect(st.activeSessionId).toBe("s2")
    expect(st.sessions.s2.messagesLoadError).toBe("db down")
  })

  it("is idempotent — re-promoting an open session just re-focuses it once", async () => {
    listMock.mockResolvedValue([])
    await promoteLegToPane("s1")
    await promoteLegToPane("s1")
    expect(useChatStore.getState().openSessionIds.filter((x) => x === "s1")).toHaveLength(1)
  })

  it("stringifies a non-Error rejection", async () => {
    listMock.mockRejectedValue("boom")
    const res = await promoteLegToPane("s3")
    expect(res.seeded).toBe(false)
    expect(useChatStore.getState().sessions.s3.messagesLoadError).toBe("boom")
  })
})
