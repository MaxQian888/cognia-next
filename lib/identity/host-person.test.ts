/** @jest-environment jsdom */

import {
  ACCOUNT_BIND_PERSON_COMMAND,
  ACCOUNT_CLEAR_CLOUD_DEPLOYMENT_COMMAND,
  ACCOUNT_PERSON_COMMAND,
  ACCOUNT_SET_CLOUD_DEPLOYMENT_COMMAND,
  ACCOUNT_UNBIND_PERSON_COMMAND,
  bindHostPerson,
  clearHostDeployment,
  configureHostDeployment,
  derivedPersonFromToken,
  readHostPerson,
  unbindHostPerson,
} from "./host-person"
import { deriveOrgId, deriveUserId } from "./sign-in"

const desktop = () => true
const web = () => false
const ISSUER = "https://logto.example.com/oidc"

function token(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`
}

// No issuer/audience travel as arguments: the host validates the token against
// its OWN configured Logto issuer. A renderer that supplies the trust anchor
// verifies nothing.
const orgToken = token({ iss: ISSUER, sub: "logto_ada", organization_id: "org_logto_1" })
const plainToken = token({ iss: ISSUER, sub: "logto_ada" })

describe("off the desktop there is no host to tell", () => {
  it("no-ops without invoking anything, and says so", async () => {
    const invokeFn = jest.fn()
    expect(
      await bindHostPerson(
        { localAccountId: "acct_a", userId: "usr_ada", accessToken: orgToken },
        { invokeFn, isDesktop: web }
      )
    ).toBe(false)
    expect(await unbindHostPerson("acct_a", { invokeFn, isDesktop: web })).toBe(false)
    expect(await readHostPerson("acct_a", { invokeFn, isDesktop: web })).toBeNull()
    expect(
      await configureHostDeployment({ gatewayUrl: "https://c" }, { invokeFn, isDesktop: web })
    ).toBeNull()
    expect(await clearHostDeployment({ invokeFn, isDesktop: web })).toBe(false)
    expect(invokeFn).not.toHaveBeenCalled()
  })

  it("takes the same branch through the real platform check under Jest", async () => {
    // jsdom is not Tauri, so the production default must reach the no-op path,
    // otherwise this module only works in tests that stub it.
    const invokeFn = jest.fn()
    expect(
      await bindHostPerson(
        { localAccountId: "acct_a", userId: "usr_ada", accessToken: orgToken },
        { invokeFn }
      )
    ).toBe(false)
    expect(invokeFn).not.toHaveBeenCalled()
  })
})

describe("derivedPersonFromToken", () => {
  it("derives the same ids the host will, from the token's own issuer", async () => {
    expect(await derivedPersonFromToken(orgToken)).toEqual({
      userId: await deriveUserId(ISSUER, "logto_ada"),
      orgId: await deriveOrgId(ISSUER, "org_logto_1"),
    })
    expect(await derivedPersonFromToken(plainToken)).toEqual({
      userId: await deriveUserId(ISSUER, "logto_ada"),
    })
  })

  it("has nothing to derive from an opaque token", async () => {
    expect(await derivedPersonFromToken("opaque")).toBeNull()
    expect(await derivedPersonFromToken(token({ sub: "no-issuer" }))).toBeNull()
  })
})

describe("on the desktop", () => {
  it("sends the derived ids the host can verify, with the caller's ids as aliases", async () => {
    const invokeFn = jest.fn().mockResolvedValue(undefined)
    await bindHostPerson(
      { localAccountId: "acct_a", userId: "usr_ada", orgId: "org_acme", accessToken: orgToken },
      { invokeFn, isDesktop: desktop }
    )
    expect(invokeFn).toHaveBeenCalledWith(ACCOUNT_BIND_PERSON_COMMAND, {
      accessToken: orgToken,
      userId: await deriveUserId(ISSUER, "logto_ada"),
      orgId: await deriveOrgId(ISSUER, "org_logto_1"),
      canonicalUserId: "usr_ada",
      canonicalOrgId: "org_acme",
    })
  })

  it("sends no aliases when the caller already holds the derived ids", async () => {
    const invokeFn = jest.fn().mockResolvedValue(undefined)
    const derivedUser = await deriveUserId(ISSUER, "logto_ada")
    const derivedOrg = await deriveOrgId(ISSUER, "org_logto_1")
    await bindHostPerson(
      { localAccountId: "acct_a", userId: derivedUser, orgId: derivedOrg, accessToken: orgToken },
      { invokeFn, isDesktop: desktop }
    )
    expect(invokeFn).toHaveBeenCalledWith(ACCOUNT_BIND_PERSON_COMMAND, {
      accessToken: orgToken,
      userId: derivedUser,
      orgId: derivedOrg,
      canonicalUserId: null,
      canonicalOrgId: null,
    })
  })

  it("sends explicit nulls rather than omitting fields", async () => {
    // `Option<String>` on the Rust side reads a missing key as an error in
    // some serde configurations. An explicit null is unambiguous either way.
    const invokeFn = jest.fn().mockResolvedValue(undefined)
    const derivedUser = await deriveUserId(ISSUER, "logto_ada")
    await bindHostPerson(
      { localAccountId: "acct_a", userId: derivedUser, accessToken: plainToken },
      { invokeFn, isDesktop: desktop }
    )
    expect(invokeFn).toHaveBeenCalledWith(ACCOUNT_BIND_PERSON_COMMAND, {
      accessToken: plainToken,
      userId: derivedUser,
      orgId: null,
      canonicalUserId: null,
      canonicalOrgId: null,
    })
  })

  it("refuses to mirror a token it cannot read, before asking the host", async () => {
    const invokeFn = jest.fn()
    await expect(
      bindHostPerson(
        { localAccountId: "acct_a", userId: "usr_ada", accessToken: "opaque" },
        { invokeFn, isDesktop: desktop }
      )
    ).rejects.toThrow(/readable issuer and subject/)
    expect(invokeFn).not.toHaveBeenCalled()
  })

  it("unbinds and reads back, aliases included", async () => {
    const invokeFn = jest.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce({
      localAccountNamespace: "acct_a",
      userId: "usr_ada",
      orgId: null,
      canonicalUserId: "usr_server",
      canonicalOrgId: null,
    })

    expect(await unbindHostPerson("acct_a", { invokeFn, isDesktop: desktop })).toBe(true)
    expect(invokeFn).toHaveBeenNthCalledWith(1, ACCOUNT_UNBIND_PERSON_COMMAND)

    expect(await readHostPerson("acct_a", { invokeFn, isDesktop: desktop })).toEqual({
      localAccountNamespace: "acct_a",
      userId: "usr_ada",
      orgId: null,
      canonicalUserId: "usr_server",
      canonicalOrgId: null,
    })
    expect(invokeFn).toHaveBeenNthCalledWith(2, ACCOUNT_PERSON_COMMAND)
  })

  it("treats a host that recorded nothing as an answer, not a failure", async () => {
    const invokeFn = jest.fn().mockResolvedValue(null)
    expect(await readHostPerson("acct_a", { invokeFn, isDesktop: desktop })).toBeNull()
  })

  it("lets a real command failure surface instead of swallowing it", async () => {
    const invokeFn = jest.fn().mockRejectedValue(new Error("locked"))
    await expect(
      bindHostPerson(
        { localAccountId: "acct_a", userId: "usr_ada", accessToken: plainToken },
        { invokeFn, isDesktop: desktop }
      )
    ).rejects.toThrow("locked")
  })

  it("points the host at a deployment by address only, and forgets it", async () => {
    const record = {
      gatewayUrl: "https://cloud.example",
      fingerprint: "ab".repeat(32),
      issuer: ISSUER,
      audience: "https://cloud.example/api",
      savedAt: 1,
    }
    const invokeFn = jest.fn().mockResolvedValueOnce(record).mockResolvedValueOnce(undefined)
    expect(
      await configureHostDeployment(
        { gatewayUrl: "https://cloud.example", fingerprint: "ab".repeat(32), replace: true },
        { invokeFn, isDesktop: desktop }
      )
    ).toEqual(record)
    // The renderer's discovered issuer is deliberately NOT an argument.
    expect(invokeFn).toHaveBeenNthCalledWith(1, ACCOUNT_SET_CLOUD_DEPLOYMENT_COMMAND, {
      gatewayUrl: "https://cloud.example",
      fingerprint: "ab".repeat(32),
      replace: true,
    })
    expect(await clearHostDeployment({ invokeFn, isDesktop: desktop })).toBe(true)
    expect(invokeFn).toHaveBeenNthCalledWith(2, ACCOUNT_CLEAR_CLOUD_DEPLOYMENT_COMMAND)
  })

  it("defaults a missing fingerprint to an explicit null and replace to false", async () => {
    const invokeFn = jest.fn().mockResolvedValue({})
    await configureHostDeployment({ gatewayUrl: "https://c" }, { invokeFn, isDesktop: desktop })
    expect(invokeFn).toHaveBeenCalledWith(ACCOUNT_SET_CLOUD_DEPLOYMENT_COMMAND, {
      gatewayUrl: "https://c",
      fingerprint: null,
      replace: false,
    })
  })
})
