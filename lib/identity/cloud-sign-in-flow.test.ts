import type { LogtoSession } from "@/lib/logto/client"
import type { CollabAccountMembership } from "@/lib/collab/client"

import type { ReadyDeployment } from "./deployment-discovery"
import {
  CloudSignInError,
  ORGANIZATIONS_SCOPE,
  adoptOrganization,
  claimDeployment,
  logtoConfigFor,
  redeemInvitation,
  resolveStanding,
  settleAfterSignIn,
  signInWithDeployment,
} from "./cloud-sign-in-flow"
import { rememberPendingInvitation } from "./pending-invitation"

const deployment: ReadyDeployment = {
  status: "ready",
  baseUrl: "https://host.example",
  config: {
    deploymentMode: "multi-tenant",
    hostId: "host",
    oidc: {
      issuer: "https://logto.example/oidc",
      webClientId: "web-app",
      nativeClientId: "native-app",
      audience: "https://api.example",
      scopes: ["collab:read"],
    },
  } as ReadyDeployment["config"],
  social: [{ provider: "github", directSignIn: "social:github" }],
  collaborationServiceUrl: "https://collab.example",
  registrationPolicy: "bootstrap-then-invite",
}

const session: LogtoSession = {
  issuer: "https://logto.example/oidc",
  clientId: "web-app",
  resource: "https://api.example",
  accessToken: "at-plain",
  refreshToken: "rt-1",
  scopes: ["openid", "offline_access", ORGANIZATIONS_SCOPE],
}

const membership = (overrides: Partial<CollabAccountMembership> = {}): CollabAccountMembership => ({
  orgId: "org_server0000000000000000",
  orgName: "Acme",
  logtoOrganizationId: "lorg_1",
  userId: "usr_server0000000000000000",
  orgRole: "owner",
  workspaceCount: 1,
  ...overrides,
})

function harness(memberships: CollabAccountMembership[] = [membership()]) {
  const client = {
    accountMemberships: jest.fn(async () => ({ subject: "sub", memberships })),
    bootstrapAccount: jest.fn(async () => ({
      operationId: "op",
      orgId: "org_new00000000000000000000",
      userId: "usr_new00000000000000000000",
      logtoOrganizationId: "lorg_new",
    })),
    acceptInvitationByToken: jest.fn(async () => ({
      operationId: "op",
      orgId: "org_inv00000000000000000000",
      userId: "usr_inv00000000000000000000",
      logtoOrganizationId: "lorg_inv",
      invitationId: "inv_1",
    })),
  }
  const registry = {
    get: jest.fn(async () => ({
      localAccountId: "acct_a",
      userId: "usr_derived00000000000000",
      logtoSubject: "sub",
      logtoIssuer: session.issuer,
    })),
    setOrgId: jest.fn(async () => ({}) as never),
    reconcileUserId: jest.fn(async () => ({}) as never),
  }
  const deps = {
    localAccountId: "acct_a",
    signIn: jest.fn(async () => session),
    complete: jest.fn(async () => undefined),
    refresh: jest.fn(async (config: { organizationId?: string }) => ({
      ...session,
      accessToken: `at-${config.organizationId}`,
      organizationId: config.organizationId,
    })),
    save: jest.fn(async () => undefined),
    registry: registry as never,
    makeClient: jest.fn(() => client),
    saveConnection: jest.fn((_: string, connection: { baseUrl: string }) => connection),
    reconcile: jest.fn(async () => ({}) as never),
    refreshPlane: jest.fn(async () => null),
    operationId: () => "op_fixed",
    now: () => 99,
    fetchImpl: jest.fn() as unknown as typeof fetch,
  }
  return { client, registry, deps }
}

describe("logtoConfigFor", () => {
  it("picks the client for the callback kind, adds the organizations scope, and passes direct sign-in", () => {
    const web = logtoConfigFor(deployment, {
      redirectUri: "https://app/logto/callback",
      clientKind: "web",
      directSignIn: "social:github",
    })
    expect(web).toMatchObject({
      issuer: deployment.config.oidc!.issuer,
      clientId: "web-app",
      resource: "https://api.example",
      directSignIn: "social:github",
    })
    expect(web.scopes).toEqual(["collab:read", ORGANIZATIONS_SCOPE])
    const native = logtoConfigFor(deployment, {
      redirectUri: "http://127.0.0.1:1/cb",
      clientKind: "native",
    })
    expect(native.clientId).toBe("native-app")
    expect(native).not.toHaveProperty("directSignIn")
  })
})

describe("signInWithDeployment", () => {
  it("signs in with the discovered configuration and binds the profile", async () => {
    const { deps } = harness()
    const drivers = { openUrl: () => {}, waitForCode: async () => ({ code: "c", state: "s" }) }
    const result = await signInWithDeployment(
      deployment,
      { kind: "social", directSignIn: "social:github" },
      drivers,
      { redirectUri: "https://app/cb", clientKind: "web" },
      deps
    )
    expect(result).toBe(session)
    expect(deps.signIn).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: "web-app", directSignIn: "social:github" }),
      drivers,
      { localAccountId: "acct_a" }
    )
    expect(deps.complete).toHaveBeenCalledWith(session, { localAccountId: "acct_a" })
  })

  it("uses a manual configuration verbatim", async () => {
    const { deps } = harness()
    const config = {
      issuer: "https://other/oidc",
      clientId: "c",
      redirectUri: "r",
      resource: "res",
    }
    await signInWithDeployment(
      deployment,
      { kind: "manual", config },
      { openUrl: () => {}, waitForCode: async () => ({ code: "c", state: "s" }) },
      { redirectUri: "unused", clientKind: "web" },
      deps
    )
    expect(deps.signIn).toHaveBeenCalledWith(config, expect.anything(), expect.anything())
  })
})

describe("resolveStanding", () => {
  it("reads the memberships with the plain token and classifies them", async () => {
    const none = harness([])
    expect(await resolveStanding(deployment, session, none.deps)).toEqual({ kind: "none" })
    expect(none.deps.makeClient).toHaveBeenCalledWith("https://collab.example", "at-plain")
    const one = harness([membership()])
    expect(await resolveStanding(deployment, session, one.deps)).toMatchObject({ kind: "one" })
    const many = harness([membership(), membership({ orgId: "org_two0000000000000000000" })])
    expect(await resolveStanding(deployment, session, many.deps)).toMatchObject({ kind: "many" })
  })

  it("refuses without a collaboration service", async () => {
    await expect(
      resolveStanding({ ...deployment, collaborationServiceUrl: null }, session, harness().deps)
    ).rejects.toMatchObject({ code: "no-collaboration-service" })
  })
})

describe("adoptOrganization", () => {
  const target = {
    orgId: "org_server0000000000000000",
    logtoOrganizationId: "lorg_1",
    userId: "usr_server0000000000000000",
  }

  /**
   * The whole point of adopting: an organization token, the binding on the
   * server's ids with the derived one kept as an alias, the connection, and
   * a first pull. In that order.
   */
  it("mints an org token, rebinds to the server's ids, connects, and pulls", async () => {
    const { deps, registry } = harness()
    const adopted = await adoptOrganization(deployment, session, target, deps)
    expect(deps.refresh).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "lorg_1", clientId: "web-app" }),
      "rt-1",
      expect.anything()
    )
    expect(deps.save).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: "at-lorg_1", organizationId: "lorg_1" }),
      "acct_a"
    )
    expect(deps.complete).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "lorg_1" }),
      { localAccountId: "acct_a" }
    )
    expect(deps.reconcile).toHaveBeenCalledWith(
      {
        localAccountId: "acct_a",
        legacyUserId: "usr_derived00000000000000",
        canonicalUserId: target.userId,
        accessToken: "at-lorg_1",
        orgId: target.orgId,
        now: 99,
      },
      { registry }
    )
    expect(registry.setOrgId).toHaveBeenCalledWith("acct_a", target.orgId, 99)
    expect(deps.saveConnection).toHaveBeenCalledWith("acct_a", {
      baseUrl: "https://collab.example",
    })
    expect(deps.refreshPlane).toHaveBeenCalledWith("acct_a")
    expect(adopted).toMatchObject({ orgId: target.orgId, userId: target.userId, reconciled: true })
  })

  it("does not reconcile when the binding already carries the server's user id", async () => {
    const { deps, registry } = harness()
    registry.get.mockResolvedValueOnce({
      localAccountId: "acct_a",
      userId: target.userId,
      logtoSubject: "sub",
      logtoIssuer: session.issuer,
    })
    const adopted = await adoptOrganization(deployment, session, target, deps)
    expect(deps.reconcile).not.toHaveBeenCalled()
    expect(adopted.reconciled).toBe(false)
  })

  it("keeps the refresh token when the org token answer omits one", async () => {
    const { deps } = harness()
    deps.refresh.mockResolvedValueOnce({
      ...session,
      accessToken: "x",
      refreshToken: undefined,
    } as never)
    await adoptOrganization(deployment, session, target, deps)
    expect(deps.save).toHaveBeenCalledWith(
      expect.objectContaining({ refreshToken: "rt-1" }),
      "acct_a"
    )
  })

  it("needs a refresh token to mint an org token", async () => {
    await expect(
      adoptOrganization(deployment, { ...session, refreshToken: undefined }, target, harness().deps)
    ).rejects.toBeInstanceOf(CloudSignInError)
  })
})

describe("claimDeployment and redeemInvitation", () => {
  it("claims with the credential and adopts the org the server created", async () => {
    const { client, deps } = harness([])
    const adopted = await claimDeployment(
      deployment,
      session,
      { credential: " secret ", orgName: " Acme ", email: "a@example.com" },
      deps
    )
    expect(client.bootstrapAccount).toHaveBeenCalledWith({
      operationId: "op_fixed",
      credential: "secret",
      orgName: "Acme",
      email: "a@example.com",
    })
    expect(adopted.orgId).toBe("org_new00000000000000000000")
    expect(deps.refresh).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "lorg_new" }),
      "rt-1",
      expect.anything()
    )
  })

  it("redeems a token and adopts the org it named", async () => {
    const { client, deps } = harness([])
    const adopted = await redeemInvitation(deployment, session, " TOKEN ", deps)
    expect(client.acceptInvitationByToken).toHaveBeenCalledWith({
      operationId: "op_fixed",
      token: "TOKEN",
    })
    expect(adopted.orgId).toBe("org_inv00000000000000000000")
  })
})

describe("settleAfterSignIn", () => {
  it("adopts the single org, offers several, and reports none", async () => {
    const one = harness()
    expect(await settleAfterSignIn(deployment, session, one.deps)).toMatchObject({
      outcome: "adopted",
      adopted: { orgId: "org_server0000000000000000" },
    })
    const many = harness([membership(), membership({ orgId: "org_two0000000000000000000" })])
    expect(await settleAfterSignIn(deployment, session, many.deps)).toMatchObject({
      outcome: "choose",
    })
    const none = harness([])
    expect(await settleAfterSignIn(deployment, session, none.deps)).toEqual({
      outcome: "unaffiliated",
    })
  })
})
