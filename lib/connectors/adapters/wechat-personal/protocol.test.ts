import { ilinkResultCode } from "./protocol"
import {
  newWechatUin,
  buildIlinkHeaders,
  buildGetUpdatesBody,
  buildSendTextBody,
  buildSendMediaBody,
  ILINK_ITEM,
  ILINK_MSG,
  ILINK_CHANNEL_VERSION,
} from "./protocol"

describe("newWechatUin", () => {
  it("is base64 of a decimal uint32 and varies per call", () => {
    const a = newWechatUin()
    const b = newWechatUin()
    // Decodes to a non-negative integer string.
    expect(Number.isInteger(Number(atob(a)))).toBe(true)
    expect(Number(atob(a))).toBeGreaterThanOrEqual(0)
    expect(a).not.toBe(b) // astronomically unlikely to collide
  })
})

describe("buildIlinkHeaders", () => {
  it("omits Authorization pre-login and includes it with a token", () => {
    const pre = buildIlinkHeaders()
    expect(pre["Content-Type"]).toBe("application/json")
    expect(pre.AuthorizationType).toBe("ilink_bot_token")
    expect(pre["X-WECHAT-UIN"]).toBeTruthy()
    expect(pre.Authorization).toBeUndefined()

    const post = buildIlinkHeaders("tok123")
    expect(post.Authorization).toBe("Bearer tok123")
  })
})

describe("request body builders", () => {
  it("buildGetUpdatesBody carries the cursor + channel version", () => {
    expect(buildGetUpdatesBody("cursor-x")).toEqual({
      get_updates_buf: "cursor-x",
      base_info: { channel_version: ILINK_CHANNEL_VERSION },
    })
  })

  it("buildSendTextBody emits a bot-direction text item echoing the context token", () => {
    const body = buildSendTextBody("u@im.wechat", "ctx-1", "hello")
    expect(body.msg.message_type).toBe(ILINK_MSG.fromBot)
    expect(body.msg.context_token).toBe("ctx-1")
    expect(body.msg.to_user_id).toBe("u@im.wechat")
    expect(body.msg.item_list).toEqual([{ type: ILINK_ITEM.text, text_item: { text: "hello" } }])
  })

  it("buildSendMediaBody maps the item type to the right item key", () => {
    const img = buildSendMediaBody("u", "ctx", ILINK_ITEM.image, { url: "cdn", aes_key: "k" })
    expect(img.msg.item_list![0]).toEqual({
      type: ILINK_ITEM.image,
      image_item: { url: "cdn", aes_key: "k" },
    })
    const file = buildSendMediaBody("u", "ctx", ILINK_ITEM.file, { file_name: "a.pdf" })
    expect(file.msg.item_list![0]).toEqual({
      type: ILINK_ITEM.file,
      file_item: { file_name: "a.pdf" },
    })
  })
})

describe("ilinkResultCode", () => {
  it.each([
    [{ ret: 0 }, 0],
    [{ errcode: 0 }, 0],
    [{ ret: 0, errcode: -14 }, -14],
    [{ ret: 42, errcode: -14 }, -14],
    [{ ret: 42, errcode: 0 }, 42],
    [{ ret: 0, errcode: 42 }, 42],
    [{}, 0],
    [null, undefined],
    [[], undefined],
    [{ ret: "0" }, undefined],
    [{ ret: Number.NaN }, undefined],
  ])("classifies %j as %s", (body, expected) => {
    expect(ilinkResultCode(body)).toBe(expected)
  })
})
