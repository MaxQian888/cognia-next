import { describe, expect, it } from "vitest"

import { toBase64Url } from "@cognia/sync-protocol"

import { fakeName } from "../test/helpers"
import { approverView, parseDeny, parseNonce, pendingView, requireState } from "./enroll"
import type { RequestRow } from "./store"

const row = (overrides: Partial<RequestRow> = {}): RequestRow => ({
  request_id: "req_1",
  device_id: "dev_R",
  platform: "web",
  sign_pub: "S",
  enc_pub: "E",
  commit_hash: "C",
  names: JSON.stringify([fakeName("dev_A"), fakeName("dev_B")]),
  state: "pending",
  created_at: 1,
  expires_at: 2,
  approver_device_id: null,
  nonce_a: null,
  nonce_r: null,
  entry_seq: null,
  finished_at: null,
  ...overrides,
})

describe("request views", () => {
  it("shows the new device the approver's nonce only once it is set", () => {
    expect(pendingView(row({ nonce_a: "A" })).nonceA).toBeNull()
    expect(
      pendingView(row({ state: "nonce_set", nonce_a: "A", approver_device_id: "dev_A" }))
    ).toMatchObject({
      nonceA: "A",
      approverDeviceId: "dev_A",
    })
  })

  it("shows each device only its own sealed name, and the revealed nonce only to the approver", () => {
    const revealed = row({
      state: "revealed",
      approver_device_id: "dev_A",
      nonce_a: "A",
      nonce_r: "R",
    })
    expect(approverView(revealed, "dev_A")).toMatchObject({
      name: { recipient: "dev_A" },
      nonceR: "R",
      open: true,
    })
    expect(approverView(revealed, "dev_B")).toMatchObject({
      name: { recipient: "dev_B" },
      nonceR: null,
    })
    expect(approverView(revealed, "dev_C").name).toBeNull()
    expect(approverView(row({ state: "denied" }), "dev_A").open).toBe(false)
  })
})

describe("request bodies", () => {
  it("parses nonces of exactly 32 bytes", () => {
    const nonce = toBase64Url(new Uint8Array(32))
    expect(parseNonce({ nonceA: nonce }, "nonceA")).toBe(nonce)
    expect(() => parseNonce({ nonceA: toBase64Url(new Uint8Array(31)) }, "nonceA")).toThrow()
    expect(() => parseNonce({ nonceA: nonce, x: 1 }, "nonceA")).toThrow()
    expect(() => parseNonce({ nonceR: nonce }, "nonceA")).toThrow()
  })

  it("parses deny reasons", () => {
    expect(parseDeny({ reason: "mismatch" })).toBe("mismatch")
    expect(() => parseDeny({ reason: "nope" })).toThrow()
  })

  it("reports expiry apart from other wrong states", () => {
    expect(() => requireState(row({ state: "expired" }), "pending")).toThrow(
      expect.objectContaining({ status: 410 })
    )
    expect(() => requireState(row({ state: "approved" }), "pending")).toThrow(
      expect.objectContaining({ status: 409 })
    )
    expect(() => requireState(row(), "pending")).not.toThrow()
  })
})
