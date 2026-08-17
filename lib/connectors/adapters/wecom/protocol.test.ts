import {
  classifyInboundFrame,
  buildSubscribeFrame,
  buildPingFrame,
  buildStreamRespondFrame,
  buildStreamWithTemplateCardFrame,
  buildTemplateCardRespondFrame,
  buildWelcomeFrame,
  buildUpdateCardFrame,
  buildSendMsgFrame,
  buildMediaInitFrame,
  buildMediaChunkFrame,
  buildMediaFinishFrame,
  newReqId,
  type WeComTemplateCard,
} from "./protocol"

describe("classifyInboundFrame", () => {
  it("classifies an aibot_msg_callback as a message", () => {
    const raw = JSON.stringify({
      cmd: "aibot_msg_callback",
      headers: { req_id: "r1" },
      body: { msgid: "m1", aibotid: "b1", chatid: "c1", chattype: "single", msgtype: "text" },
    })
    const f = classifyInboundFrame(raw)
    expect(f.kind).toBe("message")
    if (f.kind === "message") {
      expect(f.reqId).toBe("r1")
      expect(f.body.msgid).toBe("m1")
    }
  })

  it("classifies an aibot_event_callback as an event", () => {
    const raw = JSON.stringify({
      cmd: "aibot_event_callback",
      headers: { req_id: "r2" },
      body: { aibotid: "b1", msgtype: "event", event: { eventtype: "enter_chat" } },
    })
    const f = classifyInboundFrame(raw)
    expect(f.kind).toBe("event")
    if (f.kind === "event") expect(f.body.event.eventtype).toBe("enter_chat")
  })

  it("classifies a subscribe/ping ack (no cmd + errcode)", () => {
    const f = classifyInboundFrame(
      JSON.stringify({ headers: { req_id: "r3" }, errcode: 0, errmsg: "ok" })
    )
    expect(f.kind).toBe("ack")
    if (f.kind === "ack") {
      expect(f.errcode).toBe(0)
      expect(f.reqId).toBe("r3")
    }
  })

  it("returns unknown for malformed JSON and unrecognised cmds", () => {
    expect(classifyInboundFrame("not json").kind).toBe("unknown")
    expect(classifyInboundFrame(JSON.stringify({ cmd: "mystery", headers: {} })).kind).toBe(
      "unknown"
    )
  })
})

describe("outbound frame builders", () => {
  it("builds a subscribe frame", () => {
    expect(buildSubscribeFrame("r", "bot", "sec")).toEqual({
      cmd: "aibot_subscribe",
      headers: { req_id: "r" },
      body: { bot_id: "bot", secret: "sec" },
    })
  })

  it("builds a ping frame", () => {
    expect(buildPingFrame("r")).toEqual({ cmd: "ping", headers: { req_id: "r" } })
  })

  it("builds streaming respond frames with finish toggling", () => {
    const open = buildStreamRespondFrame("r", "s1", "partial", false)
    expect(open.body).toEqual({
      msgtype: "stream",
      stream: { id: "s1", content: "partial", finish: false },
    })
    const close = buildStreamRespondFrame("r", "s1", "final", true)
    expect((close.body as { stream: { finish: boolean } }).stream.finish).toBe(true)
    expect(open.cmd).toBe("aibot_respond_msg")
  })

  it("builds template_card respond frames", () => {
    const card: WeComTemplateCard = {
      card_type: "button_interaction",
      button_list: [{ key: "k", text: "Go" }],
    }
    const f = buildTemplateCardRespondFrame("r", card)
    expect(f.body).toEqual({ msgtype: "template_card", template_card: card })
  })

  it("builds welcome + update-card frames", () => {
    expect(buildWelcomeFrame("r", "hello").body).toEqual({
      msgtype: "text",
      text: { content: "hello" },
    })
    const card: WeComTemplateCard = { card_type: "button_interaction" }
    expect(buildUpdateCardFrame("r", card).body).toEqual({
      response_type: "update_template_card",
      template_card: card,
    })
  })

  it("builds a proactive send frame", () => {
    const f = buildSendMsgFrame("r", {
      chatid: "u_alice",
      chat_type: 1,
      msgtype: "markdown",
      markdown: { content: "ping" },
    })
    expect(f.cmd).toBe("aibot_send_msg")
    expect(f.body).toMatchObject({ chatid: "u_alice", chat_type: 1, msgtype: "markdown" })
  })

  it("keys proactive media bodies by msgtype (no generic `media` key)", () => {
    const f = buildSendMsgFrame("r", {
      chatid: "u_alice",
      chat_type: 1,
      msgtype: "image",
      image: { media_id: "mid1" },
    })
    expect(f.body).toEqual({
      chatid: "u_alice",
      chat_type: 1,
      msgtype: "image",
      image: { media_id: "mid1" },
    })
    expect((f.body as Record<string, unknown>).media).toBeUndefined()
  })

  it("builds a combined stream_with_template_card frame with finish:true", () => {
    const card: WeComTemplateCard = {
      card_type: "button_interaction",
      button_list: [{ key: "k", text: "Go" }],
    }
    const f = buildStreamWithTemplateCardFrame("r", "s1", "final text", card)
    expect(f.cmd).toBe("aibot_respond_msg")
    expect(f.body).toEqual({
      msgtype: "stream_with_template_card",
      stream: { id: "s1", content: "final text", finish: true },
      template_card: card,
    })
  })

  it("builds the 3-step media upload frames with the protocol field names", () => {
    const init = buildMediaInitFrame("r", {
      type: "image",
      filename: "a.png",
      totalSize: 1024,
      totalChunks: 1,
      md5: "d41d8cd98f00b204e9800998ecf8427e",
    })
    expect(init.cmd).toBe("aibot_upload_media_init")
    expect(init.body).toEqual({
      type: "image",
      filename: "a.png",
      total_size: 1024,
      total_chunks: 1,
      md5: "d41d8cd98f00b204e9800998ecf8427e",
    })
    expect(buildMediaChunkFrame("r", "up1", 0, "AAAA").body).toEqual({
      upload_id: "up1",
      chunk_index: 0,
      base64_data: "AAAA",
    })
    expect(buildMediaFinishFrame("r", "up1").body).toEqual({ upload_id: "up1" })
  })

  it("generates unique req ids scoped to the adapter", () => {
    const a = newReqId("adp")
    const b = newReqId("adp")
    expect(a.startsWith("adp:")).toBe(true)
    expect(a).not.toBe(b)
    expect(a.length).toBeLessThanOrEqual(256)
  })
})
