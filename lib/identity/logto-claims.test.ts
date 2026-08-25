import { readFileSync } from "node:fs"
import { join } from "node:path"

import {
  mergeGroupIds,
  orgRoleFromOrganizationRoles,
  readLogtoAccessClaims,
  readLogtoIdentity,
  readLogtoProfileClaims,
} from "./logto-claims"

import type { LogtoSession } from "@/lib/logto/client"

function token(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
  return `header.${encode(payload)}.signature`
}

function session(overrides: Partial<LogtoSession> = {}): LogtoSession {
  return {
    issuer: "https://logto.example.com/oidc",
    clientId: "app_1",
    resource: "https://api.cognia.local",
    accessToken: token({ sub: "logto_user_1", exp: 1_800_000 }),
    scopes: [],
    ...overrides,
  }
}

describe("readLogtoAccessClaims", () => {
  it("reads the subject, org and scopes", () => {
    const claims = readLogtoAccessClaims(
      token({
        sub: "logto_user_1",
        organization_id: "org_tenant_1",
        scope: "openid offline_access brain:rpc",
        exp: 1_800_000,
      })
    )
    expect(claims).toMatchObject({
      subject: "logto_user_1",
      organizationId: "org_tenant_1",
      scopes: ["openid", "offline_access", "brain:rpc"],
    })
  })

  it("converts exp from OIDC seconds to epoch milliseconds", () => {
    expect(readLogtoAccessClaims(token({ sub: "s", exp: 1_800_000 }))?.expiresAt).toBe(
      1_800_000_000
    )
    expect(readLogtoAccessClaims(token({ sub: "s" }))?.expiresAt).toBeUndefined()
    expect(readLogtoAccessClaims(token({ sub: "s", exp: "soon" }))?.expiresAt).toBeUndefined()
  })

  it("returns null when there is no subject to bind a person to", () => {
    expect(readLogtoAccessClaims(token({ organization_id: "org_1" }))).toBeNull()
    expect(readLogtoAccessClaims(token({ sub: "" }))).toBeNull()
    expect(readLogtoAccessClaims("not-a-token")).toBeNull()
  })

  it("leaves organizationId absent on a non-organization token", () => {
    expect(readLogtoAccessClaims(token({ sub: "s" }))?.organizationId).toBeUndefined()
  })
})

describe("mergeGroupIds — must stay byte-identical to oidc.rs", () => {
  it("merges both sources, drops blanks, dedupes and sorts", () => {
    expect(mergeGroupIds(["shared", "b"], ["a", "shared", "  ", ""])).toEqual(["a", "b", "shared"])
  })

  it("is stable regardless of which side contributed a value", () => {
    expect(mergeGroupIds(["x"], ["x"])).toEqual(["x"])
    expect(mergeGroupIds([], [])).toEqual([])
  })

  it("still mirrors the Rust source's two claim names and its set semantics", () => {
    // A parity guard, not a style check: if oidc.rs changes which claims feed
    // the group set, or stops deduping, this mirror is wrong and the renderer
    // will disagree with the host about someone's groups.
    const rust = readFileSync(join(process.cwd(), "src-tauri/src/companion_api/oidc.rs"), "utf8")
    expect(rust).toMatch(
      /\.groups\s*\n?\s*\.into_iter\(\)\s*\n?\s*\.chain\(raw\.organization_roles\)/
    )
    expect(rust).toContain("BTreeSet")
    expect(rust).toMatch(/filter\(\|group\| !group\.trim\(\)\.is_empty\(\)\)/)
  })
})

describe("orgRoleFromOrganizationRoles", () => {
  it("recognises owner and admin case-insensitively, and prefers owner", () => {
    expect(orgRoleFromOrganizationRoles(["Owner"])).toBe("owner")
    expect(orgRoleFromOrganizationRoles([" ADMIN "])).toBe("admin")
    expect(orgRoleFromOrganizationRoles(["admin", "owner"])).toBe("owner")
  })

  it("under-grants rather than guesses for anything unrecognised", () => {
    expect(orgRoleFromOrganizationRoles([])).toBe("member")
    expect(orgRoleFromOrganizationRoles(["release-managers"])).toBe("member")
  })

  it("is fed only by organization_roles, so a Logto group cannot promote", () => {
    const claims = readLogtoAccessClaims(
      token({ sub: "s", groups: ["admin"], organization_roles: ["member"] })
    )
    expect(claims?.groupIds).toEqual(["admin", "member"])
    expect(orgRoleFromOrganizationRoles(claims?.organizationRoles ?? [])).toBe("member")
  })
})

describe("readLogtoProfileClaims", () => {
  it("reads the display half and falls back from name to username", () => {
    expect(readLogtoProfileClaims(token({ name: "Ada", email: "a@x.dev" }))).toEqual({
      name: "Ada",
      email: "a@x.dev",
      picture: undefined,
    })
    expect(readLogtoProfileClaims(token({ username: "ada" })).name).toBe("ada")
  })

  it("keeps an unasserted claim absent rather than empty", () => {
    expect(readLogtoProfileClaims(undefined)).toEqual({
      name: undefined,
      email: undefined,
      picture: undefined,
    })
    expect(readLogtoProfileClaims(token({ name: "" })).name).toBeUndefined()
  })
})

describe("readLogtoIdentity", () => {
  it("assembles access, profile and the derived Org role", () => {
    const identity = readLogtoIdentity(
      session({
        accessToken: token({
          sub: "logto_user_1",
          organization_id: "org_tenant_1",
          organization_roles: ["admin"],
          exp: 1_800_000,
        }),
        idToken: token({ name: "Ada", email: "a@x.dev" }),
      })
    )
    expect(identity?.access.subject).toBe("logto_user_1")
    expect(identity?.profile.name).toBe("Ada")
    expect(identity?.orgRole).toBe("admin")
  })

  it("returns null only when there is no readable subject", () => {
    expect(readLogtoIdentity(session({ accessToken: "junk" }))).toBeNull()
    expect(readLogtoIdentity(session({ idToken: "junk" }))).not.toBeNull()
  })
})
