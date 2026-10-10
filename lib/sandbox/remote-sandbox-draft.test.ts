import {
  draftFromProvider,
  draftNeedsCredential,
  emptyProviderDraft,
  isRegistryHost,
  normalizeRegistryRules,
  providerFromDraft,
  validateProviderDraft,
  validateRegistryRules,
  type ProviderDraft,
  type ProviderDraftContext,
} from "./remote-sandbox-draft"
import type { SandboxProviderConfig } from "@/types/sandbox/remote-sandboxes"

const adding: ProviderDraftContext = { existingIds: [], storedSecretIds: [] }

function e2b(overrides: Partial<ProviderDraft> = {}): ProviderDraft {
  return { ...emptyProviderDraft("e2b"), id: "e2b", credential: "e2b_key", ...overrides }
}

function k8s(overrides: Partial<ProviderDraft["kubernetes"]> = {}): ProviderDraft {
  const draft = emptyProviderDraft("kubernetes")
  return {
    ...draft,
    id: "cluster",
    credential: "apiVersion: v1\nkind: Config\n",
    kubernetes: { ...draft.kubernetes, namespace: "cognia", ...overrides },
  }
}

const fields = (draft: ProviderDraft, context = adding) =>
  validateProviderDraft(draft, context).map((problem) => `${problem.field}:${problem.code}`)

describe("validateProviderDraft", () => {
  it("accepts a new E2B provider with the defaults and a key", () => {
    expect(fields(e2b())).toEqual([])
  })

  it("refuses ids outside the grammar, `local`, and ids already taken", () => {
    expect(fields(e2b({ id: "Bad_Id" }))).toEqual(["id:id_invalid"])
    expect(fields(e2b({ id: "local" }))).toEqual(["id:id_invalid"])
    expect(fields(e2b({ id: "a".repeat(33) }))).toEqual(["id:id_invalid"])
    expect(fields(e2b(), { existingIds: ["e2b"], storedSecretIds: [] })).toEqual(["id:id_taken"])
  })

  it("lets an edit keep its own id", () => {
    const context = { existingIds: ["e2b"], editingId: "e2b", storedSecretIds: [] }
    expect(fields(e2b(), context)).toEqual([])
  })

  it("caps labels at 64 characters", () => {
    expect(fields(e2b({ label: "x".repeat(65) }))).toEqual(["label:label_invalid"])
    expect(fields(e2b({ label: "x".repeat(64) }))).toEqual([])
  })

  it("needs a credential unless one is already stored for the provider", () => {
    expect(fields(e2b({ credential: "" }))).toEqual(["credential:credential_required"])
    const stored = e2b({
      credential: "",
      existingCredential: { secretId: "remote-sandbox:e2b" },
    })
    const editing = { existingIds: ["e2b"], editingId: "e2b", storedSecretIds: [] }
    // The id is named but nothing is stored under it.
    expect(fields(stored, editing)).toEqual(["credential:credential_required"])
    expect(fields(stored, { ...editing, storedSecretIds: ["remote-sandbox:e2b"] })).toEqual([])
    // A hand-written env or file source is kept as it is.
    expect(
      fields(e2b({ credential: "", existingCredential: { env: "E2B_API_KEY" } }), editing)
    ).toEqual([])
  })

  it("asks no credential of an in-cluster Kubernetes connection", () => {
    const draft = { ...k8s({ connection: "inCluster" }), credential: "" }
    expect(draftNeedsCredential(draft)).toBe(false)
    expect(fields(draft)).toEqual([])
  })

  it("holds limits to the Rust bounds, in minutes", () => {
    expect(fields(e2b({ maxConcurrent: "0" }))).toEqual(["maxConcurrent:out_of_range"])
    expect(fields(e2b({ maxConcurrent: "257" }))).toEqual(["maxConcurrent:out_of_range"])
    expect(fields(e2b({ maxLifetimeMinutes: "4" }))).toEqual(["maxLifetimeMinutes:out_of_range"])
    expect(fields(e2b({ maxLifetimeMinutes: "1441" }))).toEqual(["maxLifetimeMinutes:out_of_range"])
    expect(fields(e2b({ idleTimeoutMinutes: "0" }))).toEqual(["idleTimeoutMinutes:out_of_range"])
    expect(fields(e2b({ idleTimeoutMinutes: "1.5" }))).toEqual(["idleTimeoutMinutes:out_of_range"])
    const [problem] = validateProviderDraft(e2b({ maxConcurrent: "x" }), adding)
    expect(problem?.values).toEqual({ min: 1, max: 256 })
  })

  it("checks the E2B endpoint, domain, template prefix, timeout and registries", () => {
    const draft = e2b()
    expect(fields({ ...draft, e2b: { ...draft.e2b, apiUrl: "http://api.e2b.app" } })).toEqual([
      "e2b.apiUrl:url_invalid",
    ])
    expect(fields({ ...draft, e2b: { ...draft.e2b, apiUrl: "http://localhost:3000" } })).toEqual([])
    expect(fields({ ...draft, e2b: { ...draft.e2b, apiUrl: "https://u:p@api.e2b.app" } })).toEqual([
      "e2b.apiUrl:url_invalid",
    ])
    expect(fields({ ...draft, e2b: { ...draft.e2b, domain: "localhost" } })).toEqual([
      "e2b.domain:domain_invalid",
    ])
    expect(fields({ ...draft, e2b: { ...draft.e2b, domain: "10.0.0.1" } })).toEqual([
      "e2b.domain:domain_invalid",
    ])
    expect(fields({ ...draft, e2b: { ...draft.e2b, templatePrefix: "-x" } })).toEqual([
      "e2b.templatePrefix:template_prefix_invalid",
    ])
    expect(fields({ ...draft, e2b: { ...draft.e2b, templateBuildTimeoutSecs: "59" } })).toEqual([
      "e2b.templateBuildTimeoutSecs:out_of_range",
    ])
    const [registry] = validateProviderDraft(
      { ...draft, e2b: { ...draft.e2b, delegatedRegistries: "ghcr.io\nnot a host" } },
      adding
    )
    expect(registry).toEqual({
      field: "e2b.delegatedRegistries",
      code: "registry_invalid",
      values: { entry: "not a host" },
    })
  })

  it("checks the Kubernetes namespace, names, node selector and timeout", () => {
    expect(fields(k8s({ namespace: "" }))).toEqual(["kubernetes.namespace:namespace_invalid"])
    expect(fields(k8s({ namespace: "Cognia" }))).toEqual(["kubernetes.namespace:namespace_invalid"])
    expect(fields(k8s({ runtimeClassGvisor: "gVisor" }))).toEqual([
      "kubernetes.runtimeClasses:name_invalid",
    ])
    expect(fields(k8s({ nodeSelector: "pool=sandbox\nbroken" }))).toEqual([
      "kubernetes.nodeSelector:node_selector_invalid",
    ])
    expect(fields(k8s({ nodeSelector: "kubernetes.io/arch=amd64" }))).toEqual([])
    expect(fields(k8s({ serviceAccountName: "Bad" }))).toEqual([
      "kubernetes.serviceAccountName:name_invalid",
    ])
    expect(fields(k8s({ podReadyTimeoutSecs: "1801" }))).toEqual([
      "kubernetes.podReadyTimeoutSecs:out_of_range",
    ])
  })
})

describe("providerFromDraft", () => {
  it("writes an E2B provider and stores its key under the provider's own id", () => {
    const result = providerFromDraft(
      e2b({
        label: " E2B cloud ",
        e2b: { ...e2b().e2b, delegatedRegistries: "GHCR.io, ghcr.io\nregistry.acme.dev:5000" },
      }),
      adding
    )
    expect(result).toEqual({
      provider: {
        id: "e2b",
        kind: "e2b",
        label: "E2B cloud",
        credential: { secretId: "remote-sandbox:e2b" },
        limits: { maxConcurrent: 4, maxLifetimeSecs: 7200, idleTimeoutSecs: 600 },
        settings: {
          apiUrl: "https://api.e2b.app",
          domain: "e2b.app",
          templatePrefix: "cognia",
          templateBuildTimeoutSecs: 1800,
          delegatedRegistries: ["ghcr.io", "registry.acme.dev:5000"],
        },
      },
      secrets: { "remote-sandbox:e2b": "e2b_key" },
    })
  })

  it("writes a Kubernetes provider with only the settings the form filled", () => {
    const result = providerFromDraft(
      k8s({ context: "prod", runtimeClassGvisor: "gvisor", nodeSelector: "pool=sandbox" }),
      adding
    )
    expect(result?.provider).toEqual({
      id: "cluster",
      kind: "kubernetes",
      credential: { secretId: "remote-sandbox:cluster" },
      limits: { maxConcurrent: 4, maxLifetimeSecs: 7200, idleTimeoutSecs: 600 },
      settings: {
        connection: "kubeconfig",
        context: "prod",
        namespace: "cognia",
        runtimeClasses: { gvisor: "gvisor" },
        egress: "network-policy",
        nodeSelector: { pool: "sandbox" },
        podReadyTimeoutSecs: 180,
      },
    })
    expect(result?.secrets).toEqual({
      "remote-sandbox:cluster": "apiVersion: v1\nkind: Config",
    })
  })

  it("keeps the stored credential when none is typed, and touches no secret", () => {
    const context = {
      existingIds: ["e2b"],
      editingId: "e2b",
      storedSecretIds: ["remote-sandbox:e2b"],
    }
    const result = providerFromDraft(
      e2b({ credential: "", existingCredential: { secretId: "remote-sandbox:e2b" } }),
      context
    )
    expect(result?.provider.credential).toEqual({ secretId: "remote-sandbox:e2b" })
    expect(result?.secrets).toEqual({})
  })

  it("deletes the stored kubeconfig when a provider moves into the cluster", () => {
    const context = {
      existingIds: ["cluster"],
      editingId: "cluster",
      storedSecretIds: ["remote-sandbox:cluster"],
    }
    const draft = {
      ...k8s({ connection: "inCluster", context: "ignored" }),
      credential: "",
      existingCredential: { secretId: "remote-sandbox:cluster" },
    }
    const result = providerFromDraft(draft, context)
    expect(result?.provider.credential).toBeUndefined()
    expect(result?.provider.settings).not.toHaveProperty("context")
    expect(result?.secrets).toEqual({ "remote-sandbox:cluster": null })
  })

  it("replaces a renamed provider's secret when a new one is typed", () => {
    const context = {
      existingIds: ["old"],
      editingId: "old",
      storedSecretIds: ["remote-sandbox:old"],
    }
    const result = providerFromDraft(
      e2b({
        id: "new",
        credential: "fresh",
        existingCredential: { secretId: "remote-sandbox:old" },
      }),
      context
    )
    expect(result?.provider.credential).toEqual({ secretId: "remote-sandbox:new" })
    expect(result?.secrets).toEqual({ "remote-sandbox:new": "fresh", "remote-sandbox:old": null })
  })

  it("returns nothing for a form with problems", () => {
    expect(providerFromDraft(e2b({ id: "" }), adding)).toBeUndefined()
  })

  it("round-trips a provider through its form", () => {
    const provider: SandboxProviderConfig = {
      id: "cluster",
      kind: "kubernetes",
      label: "Prod",
      credential: { secretId: "remote-sandbox:cluster" },
      limits: { maxConcurrent: 8, maxLifetimeSecs: 3600, idleTimeoutSecs: 120 },
      settings: {
        connection: "kubeconfig",
        namespace: "cognia",
        runtimeClasses: { vm: "kata" },
        egress: "cilium",
        nodeSelector: { pool: "sandbox" },
        serviceAccountName: "runner",
        podReadyTimeoutSecs: 300,
      },
    }
    const draft = draftFromProvider(provider)
    expect(draft.credential).toBe("")
    expect(draft.maxLifetimeMinutes).toBe("60")
    const result = providerFromDraft(draft, {
      existingIds: ["cluster"],
      editingId: "cluster",
      storedSecretIds: ["remote-sandbox:cluster"],
    })
    expect(result).toEqual({ provider, secrets: {} })
  })
})

describe("registry allowlist", () => {
  it("reads registry hosts as the Rust side does", () => {
    expect(isRegistryHost("ghcr.io")).toBe(true)
    expect(isRegistryHost("localhost:5000")).toBe(true)
    expect(isRegistryHost("registry")).toBe(false)
    expect(isRegistryHost("ghcr.io:70000")).toBe(false)
  })

  it("flags bad hosts, bad prefixes and duplicates by row", () => {
    const problems = validateRegistryRules([
      { registry: "ghcr.io", repositoryPrefix: "acme/" },
      { registry: "nohost", repositoryPrefix: "" },
      { registry: "docker.io", repositoryPrefix: "Acme" },
      { registry: "GHCR.io", repositoryPrefix: "acme" },
      { registry: "docker.io", repositoryPrefix: "library/node__x" },
    ])
    expect([...problems.entries()]).toEqual([
      [1, "registry_invalid"],
      [2, "prefix_invalid"],
      [3, "duplicate"],
    ])
  })

  it("normalizes rows for saving", () => {
    expect(
      normalizeRegistryRules([
        { registry: " GHCR.io ", repositoryPrefix: " acme ", insecure: false },
        { registry: "localhost:5000", repositoryPrefix: "", insecure: true },
      ])
    ).toEqual([
      { registry: "ghcr.io", repositoryPrefix: "acme" },
      { registry: "localhost:5000", repositoryPrefix: "", insecure: true },
    ])
  })
})
