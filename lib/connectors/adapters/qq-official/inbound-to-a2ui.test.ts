import { qqOfficialInboundToA2UI } from "./inbound-to-a2ui"
import type { QQDispatch } from "./parse"

function dispatch(d: QQDispatch["d"]): QQDispatch {
  return { t: "C2C_MESSAGE_CREATE", op: 0, d }
}

describe("qqOfficialInboundToA2UI", () => {
  it("returns null for non-object, missing d, and empty content w/o attachments", () => {
    expect(qqOfficialInboundToA2UI(undefined as unknown as QQDispatch)).toBeNull()
    expect(qqOfficialInboundToA2UI(dispatch(undefined))).toBeNull()
    expect(qqOfficialInboundToA2UI(dispatch({ id: "1", content: "" }))).toBeNull()
  })

  it("maps text content and strips a leading channel mention", () => {
    expect(qqOfficialInboundToA2UI(dispatch({ id: "1", content: "hello" }))!.body).toEqual([
      { kind: "text", text: "hello" },
    ])
    expect(
      qqOfficialInboundToA2UI({
        ...dispatch({ id: "1", content: "<@!123> hey there" }),
        t: "AT_MESSAGE_CREATE",
      })!.body
    ).toEqual([{ kind: "text", text: "hey there" }])
  })

  it("surfaces image and file attachments from the raw dispatch", () => {
    const out = qqOfficialInboundToA2UI(
      dispatch({
        id: "1",
        content: "look",
        // attachments is not on the typed QQMessageData but arrives on the wire
        ...({
          attachments: [
            { url: "https://x/p.png", content_type: "image/png", filename: "p.png" },
            { url: "https://x/d.pdf", content_type: "application/pdf", filename: "d.pdf" },
          ],
        } as object),
      } as QQDispatch["d"])
    )
    expect(out!.body).toEqual([
      { kind: "text", text: "look" },
      { kind: "image", url: "https://x/p.png", alt: "p.png" },
      { kind: "link", href: "https://x/d.pdf", label: "d.pdf" },
    ])
    expect(out!.source).toBe("qq-official")
  })

  it("skips attachments without a url and defaults the link label / content_type", () => {
    const out = qqOfficialInboundToA2UI(
      dispatch({
        id: "1",
        content: "",
        ...({
          attachments: [
            { filename: "no-url.png" }, // no url → skipped
            { url: "https://x/d" }, // no content_type, no filename → link "Attachment"
          ],
        } as object),
      } as QQDispatch["d"])
    )
    expect(out!.body).toEqual([{ kind: "link", href: "https://x/d", label: "Attachment" }])
  })
})
it("uses normalized attachment URLs and preserves references and non-channel mention text", () => {
  const out = qqOfficialInboundToA2UI(
    dispatch({
      id: "m1",
      content: "<@!123> quoted text",
      message_reference: { message_id: "previous" },
      attachments: [
        null,
        { url: "//cdn.example/p.png", content_type: "image/png" },
        { url: "javascript:bad", content_type: "image/png" },
      ],
    } as unknown as NonNullable<QQDispatch["d"]>)
  )
  expect(out?.body).toEqual([
    { kind: "reply_context", replyToMessageId: "previous" },
    { kind: "text", text: "<@!123> quoted text" },
    { kind: "image", url: "https://cdn.example/p.png", alt: undefined },
  ])
})
