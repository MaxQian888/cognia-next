import { IDENTITIES_CLAIM, identitiesFromIdToken, issuerIdentities } from "./issuer-identities"

function token(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`
}

describe("identitiesFromIdToken", () => {
  it("reads the linked sign-ins, Feishu with its tenant", () => {
    const idToken = token({
      sub: "usr_1",
      [IDENTITIES_CLAIM]: [
        { provider: "lark", tenant: "tenant_1", subject: "on_union_1" },
        { provider: "github", subject: "583231" },
      ],
    })
    expect(identitiesFromIdToken(idToken)).toEqual([
      { provider: "lark", tenant: "tenant_1", subject: "on_union_1" },
      { provider: "github", subject: "583231" },
    ])
  })

  it("skips entries it cannot read instead of failing the sign-in", () => {
    const idToken = token({
      [IDENTITIES_CLAIM]: [
        null,
        "github",
        { provider: "github" },
        { provider: " ", subject: "x" },
        { provider: "google", subject: " 1234 ", tenant: 7 },
      ],
    })
    expect(identitiesFromIdToken(idToken)).toEqual([{ provider: "google", subject: "1234" }])
  })

  it("answers nothing for a token without the claim, or without a token", () => {
    expect(identitiesFromIdToken(token({ sub: "usr_1" }))).toEqual([])
    expect(identitiesFromIdToken(token({ [IDENTITIES_CLAIM]: "lark" }))).toEqual([])
    expect(identitiesFromIdToken("opaque")).toEqual([])
    expect(identitiesFromIdToken(undefined)).toEqual([])
    expect(issuerIdentities({})).toEqual([])
  })
})
