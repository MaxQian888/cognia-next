// The Worker, the self-hosted Rust server, and `crates/cognia-tenant-auth`
// must agree on the grant wire format — ADR-0149 §8.
//
// Three implementations exist because neither service can depend on that
// crate: `.github/workflows/images.yml` builds them with their own directory
// as the Docker context, and this one is TypeScript besides. Duplicated code
// that nothing pins drifts, and the drift would surface only in production, as
// "sharing stopped working".
//
// So all three verify the same frozen bytes. The fixture lives beside the
// crate that owns the format. Never regenerate it: a change to it IS a wire
// break, and it should be as hard to make silently as any other one.

import { describe, it, expect } from "vitest"

import vector from "../../../../crates/cognia-tenant-auth/fixtures/grant-wire-vector.json"

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/")
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4))
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function hexToBytes(value: string): Uint8Array {
  const out = new Uint8Array(value.length / 2)
  for (let index = 0; index < out.length; index++) {
    out[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
  }
  return out
}

describe("grant wire parity", () => {
  it("verifies the frozen vector with the same primitives the Worker uses", async () => {
    const [payload, signature] = vector.token.split(".")
    const key = await crypto.subtle.importKey(
      "raw",
      hexToBytes(vector.keyHex),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    )
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      base64UrlToBytes(signature),
      new TextEncoder().encode(payload)
    )
    expect(valid).toBe(true)
  })

  it("decodes the exact claim bytes that were signed", async () => {
    const [payload] = vector.token.split(".")
    expect(new TextDecoder().decode(base64UrlToBytes(payload))).toBe(vector.claimsJson)
    const claims = JSON.parse(vector.claimsJson)
    expect(claims.orgId).toBe("org_acmecorporation000001")
    expect(claims.userId).toBe("usr_adalovelace000000000001")
  })
})
