import {
  __resetPromptVerdictsForTests,
  resolvePrompt,
  resolvePromptAsync,
  selectPromptOverride,
} from "./resolve"
import { __resetPromptResolutionsForTests, lastPromptResolution } from "./resolution-log"
import {
  __setPromptOverrideSnapshotForTests,
  buildPromptOverrideSnapshot,
  type ActivePromptOverride,
} from "./snapshot"
import { definePrompt } from "./types"

const def = definePrompt({
  id: "generation.title.chat",
  contractVersion: 2,
  kind: "feature-template",
  group: "generation",
  operation: "replace-template",
  scopes: ["account", "workspace", "session"],
  activation: "next-operation",
  risk: "ordinary",
  hosts: ["app"],
  defaultBody: "Shipped title prompt for {{locale}}.",
  variables: [{ name: "locale", required: false, maxChars: 20 }],
  consumers: [],
})

function override(
  scope: ActivePromptOverride["scope"],
  targetId: string,
  body: string,
  extra: Partial<ActivePromptOverride> = {}
): ActivePromptOverride {
  return {
    bindingId: `pob_${scope}_${targetId}`,
    promptId: def.id,
    scope,
    targetId,
    revisionId: `por_${scope}_${targetId}`,
    body,
    contractVersion: 2,
    ...extra,
  }
}

const snapshotOf = (...rows: ActivePromptOverride[]) => buildPromptOverrideSnapshot("db", rows)

beforeEach(() => {
  __resetPromptVerdictsForTests()
  __resetPromptResolutionsForTests()
  __setPromptOverrideSnapshotForTests(null)
})

describe("selectPromptOverride", () => {
  const snapshot = snapshotOf(
    override("account", "", "account body"),
    override("workspace", "ws1", "workspace body"),
    override("session", "s1", "session body"),
    override("agent", "a1", "agent body")
  )

  it("prefers the most specific eligible scope", () => {
    expect(selectPromptOverride(def, { workspaceId: "ws1", sessionId: "s1" }, snapshot)?.body).toBe(
      "session body"
    )
    expect(selectPromptOverride(def, { workspaceId: "ws1", sessionId: "s2" }, snapshot)?.body).toBe(
      "workspace body"
    )
    expect(selectPromptOverride(def, {}, snapshot)?.body).toBe("account body")
  })

  it("ignores scopes the definition does not declare", () => {
    // The definition has no agent scope, so an agent override never applies.
    expect(selectPromptOverride(def, { agentId: "a1" }, snapshot)?.body).toBe("account body")
  })

  it("only applies a targeted override to a call that names its target", () => {
    const onlyWorkspace = snapshotOf(override("workspace", "ws1", "workspace body"))
    expect(selectPromptOverride(def, {}, onlyWorkspace)).toBeUndefined()
    expect(selectPromptOverride(def, { workspaceId: "ws2" }, onlyWorkspace)).toBeUndefined()
  })
})

describe("resolvePrompt", () => {
  it("renders the shipped body when nothing is overridden", () => {
    const result = resolvePrompt(def, { snapshot: snapshotOf(), values: { locale: "en" } })
    expect(result.text).toBe("Shipped title prompt for en.")
    expect(result.source).toEqual({ kind: "default" })
  })

  it("renders the selected override and reports where it came from", () => {
    const result = resolvePrompt(def, {
      snapshot: snapshotOf(override("account", "", "Custom {{locale}} title.")),
      values: { locale: "zh" },
    })
    expect(result.text).toBe("Custom zh title.")
    expect(result.source).toEqual({
      kind: "override",
      scope: "account",
      bindingId: "pob_account_",
      revisionId: "por_account_",
    })
    expect(lastPromptResolution(def.id)?.source.kind).toBe("override")
  })

  it("falls back to the shipped body for an older contract", () => {
    const result = resolvePrompt(def, {
      snapshot: snapshotOf(override("account", "", "Old", { contractVersion: 1 })),
    })
    expect(result.body).toBe(def.defaultBody)
    expect(result.source).toEqual({
      kind: "default",
      fallback: "contract-incompatible",
      skippedRevisionId: "por_account_",
    })
  })

  it("falls back for a body that no longer validates or that leaks a secret", () => {
    expect(
      resolvePrompt(def, { snapshot: snapshotOf(override("account", "", "Uses {{unknown}}")) })
        .source
    ).toMatchObject({ kind: "default", fallback: "invalid-body" })
    expect(
      resolvePrompt(def, {
        snapshot: snapshotOf(
          override("session", "s1", "token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123")
        ),
        context: { sessionId: "s1" },
      }).source
    ).toMatchObject({ kind: "default", fallback: "pii-blocked" })
  })

  it("says so instead of claiming no override when no snapshot is loaded", () => {
    expect(resolvePrompt(def).source).toEqual({ kind: "default", fallback: "snapshot-unavailable" })
  })

  it("never applies an override to an inspect-only entry", () => {
    const protocol = definePrompt({ ...def, id: def.id, operation: "inspect-only", scopes: [] })
    const result = resolvePrompt(protocol, { snapshot: snapshotOf(override("account", "", "x")) })
    expect(result.source).toEqual({ kind: "default" })
  })
})

describe("resolvePromptAsync", () => {
  it("uses the installed snapshot", async () => {
    __setPromptOverrideSnapshotForTests(snapshotOf(override("account", "", "Async body")))
    expect((await resolvePromptAsync(def)).text).toBe("Async body")
  })

  it("reads a caller's frozen snapshot instead of the current one", async () => {
    const frozen = snapshotOf(override("account", "", "Frozen body"))
    __setPromptOverrideSnapshotForTests(snapshotOf(override("account", "", "Published later")))
    expect((await resolvePromptAsync(def, { snapshot: frozen })).text).toBe("Frozen body")
    // An explicit null means "no overrides are known": the shipped body.
    expect((await resolvePromptAsync(def, { snapshot: null })).body).toBe(def.defaultBody)
  })
})
