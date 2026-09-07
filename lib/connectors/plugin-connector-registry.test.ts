/** @jest-environment node */
/**
 * Tests for the plugin connector kind registry.
 *
 * Kind ownership is exclusive, and the reason is not tidiness: two owners for
 * one kind would make which adapter a row builds depend on plugin load order,
 * which is not something a user could ever debug. Everything here defends that.
 */

import {
  __resetPluginConnectorRegistryForTesting,
  buildPluginAdapter,
  contributionIdOf,
  getPluginConnector,
  isUsableConfigSchema,
  listPluginConnectors,
  listPluginConnectorsFor,
  pluginConnectorSecretFields,
  registerPluginConnector,
  unregisterPluginConnectors,
} from "./plugin-connector-registry"
import type { PluginConnectorDef } from "@/types/plugin/plugin"

function def(over: Partial<PluginConnectorDef> = {}): PluginConnectorDef {
  return {
    type: "mastodon",
    factory: "createAdapter",
    configSchema: { type: "object", properties: {} },
    transportModes: ["longpoll"],
    ...over,
  } as PluginConnectorDef
}

function register(over: Partial<PluginConnectorDef> = {}, pluginId = "p1", factory = jest.fn()) {
  return registerPluginConnector({
    pluginId,
    pluginRelease: "1.0.0",
    def: def(over),
    factory,
  })
}

beforeEach(() => {
  __resetPluginConnectorRegistryForTesting()
})

describe("registerPluginConnector", () => {
  it("registers a fresh kind and makes it resolvable", () => {
    const result = register()
    expect(result.ok).toBe(true)
    expect(getPluginConnector("mastodon")?.pluginId).toBe("p1")
    expect(listPluginConnectors().map((r) => r.type)).toEqual(["mastodon"])
  })

  it("records the plugin release so an instance can be traced to what made it", () => {
    const result = registerPluginConnector({
      pluginId: "p1",
      pluginRelease: "2.4.1",
      def: def(),
      factory: jest.fn(),
    })
    expect(result.ok && result.registration.pluginRelease).toBe("2.4.1")
  })

  it("lets the same plugin re-register its own kind (re-enable is not a conflict)", () => {
    expect(register().ok).toBe(true)
    expect(register().ok).toBe(true)
  })

  it.each([
    ["telegram", "kind_conflict_builtin"],
    ["matrix", "kind_conflict_builtin"],
    ["email", "kind_conflict_reserved"],
    ["kook", "kind_conflict_reserved"],
  ])("refuses %s with %s", (type, reason) => {
    const result = register({ type })
    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toBe(reason)
  })

  it("refuses a kind another plugin owns, and keeps the first owner", () => {
    register({}, "p1")
    const result = register({}, "p2")
    expect(!result.ok && result.reason).toBe("kind_conflict_plugin")
    expect(getPluginConnector("mastodon")?.pluginId).toBe("p1")
  })

  it.each([
    ["", "empty"],
    ["A", "too short"],
    ["My Connector", "spaces"],
    ["plugin/connector", "a path separator"],
    ["UPPER", "uppercase"],
    ["a".repeat(65), "too long"],
  ])("refuses %s (%s) as a kind", (type) => {
    const result = register({ type })
    expect(!result.ok && result.reason).toBe("kind_invalid")
  })

  it("refuses a missing or non-callable factory", () => {
    const missing = registerPluginConnector({
      pluginId: "p1",
      pluginRelease: "1.0.0",
      def: def(),
      factory: undefined,
    })
    expect(!missing.ok && missing.reason).toBe("factory_missing")
  })

  it.each([[undefined], [null], ["nope"], [42], [[]], [{ type: "string" }], [{ properties: [] }]])(
    "refuses an unusable config schema (%p)",
    (configSchema) => {
      const result = register({ configSchema } as Partial<PluginConnectorDef>)
      expect(!result.ok && result.reason).toBe("schema_unsupported")
    }
  )

  it("accepts a schema with no properties — an empty settings shape is valid", () => {
    expect(register({ configSchema: {} }).ok).toBe(true)
  })
})

describe("isUsableConfigSchema", () => {
  it("accepts object schemas and rejects everything a form cannot be built from", () => {
    expect(isUsableConfigSchema({ type: "object", properties: {} })).toBe(true)
    expect(isUsableConfigSchema({})).toBe(true)
    expect(isUsableConfigSchema({ type: "array" })).toBe(false)
    expect(isUsableConfigSchema([])).toBe(false)
    expect(isUsableConfigSchema(null)).toBe(false)
  })
})

describe("contributionIdOf", () => {
  it("prefers the explicit id", () => {
    expect(contributionIdOf(def({ contributionId: "timeline" }))).toBe("timeline")
  })

  it("falls back to the kind for definitions predating the field", () => {
    // Correct because a plugin could only ever contribute one connector per kind.
    expect(contributionIdOf(def())).toBe("mastodon")
    expect(contributionIdOf(def({ contributionId: "  " }))).toBe("mastodon")
  })
})

describe("unregisterPluginConnectors", () => {
  it("removes only that plugin's kinds and reports them", () => {
    register({ type: "mastodon" }, "p1")
    register({ type: "bluesky" }, "p2")

    expect(unregisterPluginConnectors("p1")).toEqual(["mastodon"])
    expect(getPluginConnector("mastodon")).toBeUndefined()
    expect(getPluginConnector("bluesky")?.pluginId).toBe("p2")
  })

  it("is a no-op for a plugin that owns nothing", () => {
    expect(unregisterPluginConnectors("nobody")).toEqual([])
  })

  it("frees the kind for another plugin to claim", () => {
    register({}, "p1")
    unregisterPluginConnectors("p1")
    expect(register({}, "p2").ok).toBe(true)
  })
})

describe("listPluginConnectorsFor", () => {
  it("returns one plugin's contributions, sorted", () => {
    register({ type: "zeta" }, "p1")
    register({ type: "alpha" }, "p1")
    register({ type: "other" }, "p2")
    expect(listPluginConnectorsFor("p1").map((r) => r.type)).toEqual(["alpha", "zeta"])
  })
})

describe("buildPluginAdapter", () => {
  it("delegates to the owning plugin's factory", async () => {
    const adapter = { id: "a" }
    const factory = jest.fn().mockResolvedValue(adapter)
    register({}, "p1", factory)

    expect(await buildPluginAdapter({ id: "row-1", type: "mastodon" })).toBe(adapter)
    expect(factory).toHaveBeenCalledWith({
      pluginId: "p1",
      connectorDef: expect.objectContaining({ type: "mastodon" }),
    })
  })

  it("returns null for an unowned kind, so the row is explainable rather than fatal", async () => {
    expect(await buildPluginAdapter({ id: "row-1", type: "mastodon" })).toBeNull()
  })
})

/**
 * The schema is the only place an author can say "this one is a secret", and
 * getting it wrong writes a bot token into `settings` — a plain Dexie row that
 * backups and exports copy. Both JSON-Schema spellings are honoured because
 * both are what authors actually write.
 */
describe("pluginConnectorSecretFields", () => {
  it("reads draft-07 writeOnly", () => {
    expect(
      pluginConnectorSecretFields({
        type: "object",
        properties: { host: { type: "string" }, token: { type: "string", writeOnly: true } },
      })
    ).toEqual(["token"])
  })

  it("reads format: password", () => {
    expect(
      pluginConnectorSecretFields({
        properties: { apiKey: { type: "string", format: "password" } },
      })
    ).toEqual(["apiKey"])
  })

  it("treats an ordinary field as ordinary", () => {
    expect(pluginConnectorSecretFields({ properties: { endpoint: { type: "string" } } })).toEqual(
      []
    )
  })

  it("says nothing about a schema the host already refuses", () => {
    expect(pluginConnectorSecretFields(null)).toEqual([])
    expect(pluginConnectorSecretFields({ type: "array" })).toEqual([])
  })

  it("tolerates a schema with no properties at all", () => {
    expect(pluginConnectorSecretFields({ type: "object" })).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Declared webhook verification. Rust has hand-written verifiers only for the
// four native webhook platforms, so a plugin kind's scheme has to travel with
// its registration or the endpoint refuses everything that reaches it.
// ---------------------------------------------------------------------------

describe("webhook verification", () => {
  const hmac = {
    kind: "hmacSha256" as const,
    secretKey: "signingSecret",
    signatureHeader: "X-Acme-Signature",
    basestring: "v0:{timestamp}:{body}",
    timestampHeader: "X-Acme-Timestamp",
  }

  it("accepts a connector that declares a usable scheme", () => {
    const result = register({ transportModes: ["webhook"], webhookVerification: hmac })
    expect(result.ok).toBe(true)
    expect(getPluginConnector("mastodon")?.def.webhookVerification).toEqual(hmac)
  })

  it("allows a connector to declare none", () => {
    // Rust fails closed without one, so the connector receives nothing rather
    // than accepting anything, and an outbound-only connector has nothing to
    // verify in the first place.
    expect(register({ transportModes: ["longpoll"] }).ok).toBe(true)
  })

  it("refuses a basestring that does not cover the body", () => {
    // Such a signature authenticates the sender of some request rather than
    // this one, so a captured header would carry an attacker's payload.
    const result = register({
      transportModes: ["webhook"],
      webhookVerification: { ...hmac, basestring: "v0:{timestamp}" },
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.reason).toBe("verification_invalid")
    expect(result.message).toContain("{body}")
  })

  it("refuses a timestamped basestring with no timestamp header", () => {
    const result = register({
      transportModes: ["webhook"],
      webhookVerification: { ...hmac, timestampHeader: undefined },
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.reason).toBe("verification_invalid")
  })

  it.each([
    ["an empty secret key", { ...hmac, secretKey: "  " }],
    ["an empty signature header", { ...hmac, signatureHeader: "" }],
    ["a non-positive replay window", { ...hmac, toleranceSecs: 0 }],
  ])("refuses %s", (_label, verification) => {
    const result = register({ transportModes: ["webhook"], webhookVerification: verification })
    expect(result.ok).toBe(false)
  })

  it("refuses a shared-secret scheme with no header to read", () => {
    const result = register({
      transportModes: ["webhook"],
      webhookVerification: { kind: "sharedSecretHeader", secretKey: "tok", header: "" },
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.reason).toBe("verification_invalid")
  })

  it("accepts the shared-secret scheme Telegram uses", () => {
    const result = register({
      transportModes: ["webhook"],
      webhookVerification: {
        kind: "sharedSecretHeader",
        secretKey: "secretToken",
        header: "X-Acme-Secret",
      },
    })
    expect(result.ok).toBe(true)
  })

  it("leaves the kind registered to nobody when the scheme is refused", () => {
    // A rejected contribution must not take the kind, or a later plugin that
    // declares it correctly would collide with a registration that never
    // happened.
    register({ transportModes: ["webhook"], webhookVerification: { ...hmac, secretKey: "" } })
    expect(getPluginConnector("mastodon")).toBeUndefined()
  })
})
