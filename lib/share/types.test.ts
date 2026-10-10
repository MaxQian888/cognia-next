import type { SharePayload, SharePublicMetadata, CreateShareRequest } from "./types"

describe("SharePayload", () => {
  it("accepts the workflow result discriminator used by published workflow shares", () => {
    const payload = {
      kind: "workflow-result",
      mime: "application/json",
      data: '{"ok":true}',
      encoding: "utf8",
    } satisfies SharePayload

    expect(payload.kind).toBe("workflow-result")
  })
})

it("keeps public lifecycle metadata separate from encrypted payloads", () => {
  const metadata = {
    passphrase: true,
    burnAfterRead: true,
    maxViews: 1,
  } satisfies SharePublicMetadata
  expect(Object.keys(metadata)).toEqual(["passphrase", "burnAfterRead", "maxViews"])
  const body: Partial<CreateShareRequest> = { ttlSeconds: 30 * 86400, passphrase: true }
  expect(body.ttlSeconds).toBe(2592000)
})
