import type {
  CapabilityGrant,
  ExternalCapability,
  ServiceConnection,
} from "@/types/external-service"

import {
  authorizeExternalCapability,
  extractCapabilityResourceScopes,
  grantCoversOperation,
} from "./grants"

const connection: ServiceConnection = {
  id: "connection-1",
  serviceId: "github",
  providerId: "api",
  runtimeTargetId: "desktop",
  status: "connected",
  providerFingerprint: "fingerprint-1",
  providerRef: { kind: "integration", accountId: "account-1" },
  enabledSurfaces: ["chat", "workflow"],
  createdAt: "2026-08-23T00:00:00.000Z",
  updatedAt: "2026-08-23T00:00:00.000Z",
}

function capability(risk: ExternalCapability["risk"]): ExternalCapability {
  return {
    pluginId: "delivery",
    serviceId: "github",
    providerId: "api",
    capabilityId: "updateIssue",
    operationId: "issue.update",
    kind: "action",
    risk,
    scopeSelectors: [{ kind: "repository", jsonPointer: "/repository" }],
    surfaces: ["chat", "workflow"],
  }
}

function grant(overrides: Partial<CapabilityGrant> = {}): CapabilityGrant {
  return {
    id: "grant-1",
    connectionId: connection.id,
    providerFingerprint: connection.providerFingerprint,
    operationPatterns: ["issue.*"],
    accountId: "account-1",
    resourceScopes: [{ kind: "repository", values: ["acme/app"] }],
    workflowId: "workflow-1",
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:00.000Z",
    ...overrides,
  }
}

describe("external capability grants", () => {
  it("allows trusted reads without a grant", () => {
    expect(
      authorizeExternalCapability({
        capability: capability("read"),
        connection,
        grants: [],
        context: { interactive: false },
      })
    ).toEqual({ decision: "allow", reason: "read-default" })
  })

  it("fails closed for an unknown headless capability", () => {
    expect(
      authorizeExternalCapability({
        connection,
        grants: [],
        context: { interactive: false },
      })
    ).toEqual({ decision: "deny", reason: "unknown-capability" })
  })

  it("allows a workflow write only with matching fingerprint, operation, account, and resource", () => {
    expect(
      authorizeExternalCapability({
        capability: capability("write"),
        connection,
        grants: [grant()],
        context: {
          interactive: false,
          accountId: "account-1",
          workflowId: "workflow-1",
          resourceScopes: [{ kind: "repository", value: "acme/app" }],
        },
      })
    ).toEqual({ decision: "allow", reason: "scoped-grant", grantId: "grant-1" })

    expect(
      authorizeExternalCapability({
        capability: capability("write"),
        connection,
        grants: [grant({ providerFingerprint: "old" })],
        context: {
          interactive: false,
          accountId: "account-1",
          workflowId: "workflow-1",
          resourceScopes: [{ kind: "repository", value: "acme/app" }],
        },
      })
    ).toEqual({ decision: "deny", reason: "grant-required" })
  })

  it("does not let a normal write grant authorize destructive behavior", () => {
    expect(
      authorizeExternalCapability({
        capability: capability("destructive"),
        connection,
        grants: [grant()],
        context: {
          interactive: true,
          accountId: "account-1",
          workflowId: "workflow-1",
          resourceScopes: [{ kind: "repository", value: "acme/app" }],
        },
      })
    ).toEqual({ decision: "ask", reason: "destructive-confirmation" })
  })

  it("extracts declared JSON pointer scopes and rejects absent values", () => {
    expect(
      extractCapabilityResourceScopes(capability("write"), { repository: "acme/app" })
    ).toEqual({ ok: true, scopes: [{ kind: "repository", value: "acme/app" }] })
    expect(extractCapabilityResourceScopes(capability("write"), {})).toEqual({
      ok: false,
      reason: 'Missing required resource scope "repository"',
    })
  })
})

describe("grantCoversOperation", () => {
  const context = { accountId: "account-1", workflowId: "workflow-1" }

  it("matches the operation, connection and binding, whatever the resource scopes", () => {
    expect(grantCoversOperation(grant(), capability("write"), connection, context)).toBe(true)
    expect(
      grantCoversOperation(
        grant({ resourceScopes: [{ kind: "repository", values: ["other/repo"] }] }),
        capability("write"),
        connection,
        context
      )
    ).toBe(true)
  })

  it.each([
    ["another operation", grant({ operationPatterns: ["pull.*"] }), context],
    ["another account", grant(), { ...context, accountId: "account-2" }],
    ["another workflow", grant(), { accountId: "account-1" }],
    ["another session", grant({ sessionId: "s1" }), context],
    ["an expired grant", grant({ expiresAt: "2000-01-01T00:00:00.000Z" }), context],
    ["another fingerprint", grant({ providerFingerprint: "fingerprint-2" }), context],
  ])("does not match %s", (_label, candidate, candidateContext) => {
    expect(grantCoversOperation(candidate, capability("write"), connection, candidateContext)).toBe(
      false
    )
  })

  it("needs allowDestructive for a destructive operation", () => {
    expect(grantCoversOperation(grant(), capability("destructive"), connection, context)).toBe(
      false
    )
    expect(
      grantCoversOperation(
        grant({ allowDestructive: true }),
        capability("destructive"),
        connection,
        context
      )
    ).toBe(true)
  })
})
