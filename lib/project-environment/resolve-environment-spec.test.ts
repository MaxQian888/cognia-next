import type { ProjectRuntimeSelection } from "@/types/project-environment"
import type {
  EnvironmentCatalogEntryView,
  EnvironmentCatalogView,
} from "@/types/sandbox/environment-catalog"

import { parseDevcontainer } from "./devcontainer"
import {
  environmentDeclarationDigest,
  parseWorkspaceEnvironmentBlock,
} from "./environment-declaration"
import { computeEnvironmentSpecDigest } from "./environment-spec-digest"
import type { EnvironmentDeclarationVerdict } from "./read-environment-declaration"
import {
  deviceApprovalRef,
  deviceApprovalView,
  parseImageUser,
  resolveEnvironmentSpec,
  type EnvironmentApprovalView,
  type EnvironmentSpecResolution,
  type ResolveEnvironmentSpecInput,
} from "./resolve-environment-spec"

const digest = (char: string) => `sha256:${char.repeat(64)}`

const NODE: EnvironmentCatalogEntryView = {
  id: "node-22",
  scope: "baseline",
  label: "Node 22",
  image: { registry: "docker.io", repository: "library/node", digest: digest("1"), tag: "22" },
  effectiveFloor: "container",
  sizeClassIds: ["small", "medium"],
  imageUser: "node:node",
  source: "manual",
}
const PYTHON: EnvironmentCatalogEntryView = {
  id: "python-3.12",
  scope: "tenant",
  label: "Python",
  image: { registry: "docker.io", repository: "library/python", digest: digest("2") },
  effectiveFloor: "gvisor",
  sizeClassIds: ["medium", "gpu-1"],
  source: "manual",
}
const LEGACY: EnvironmentCatalogEntryView = {
  id: "legacy-env",
  scope: "baseline",
  label: "Legacy",
  image: { registry: "ghcr.io", repository: "acme/runner", tag: "latest" },
  effectiveFloor: "container",
  sizeClassIds: ["small"],
  source: "legacy",
}

function catalog(over: Partial<EnvironmentCatalogView> = {}): EnvironmentCatalogView {
  return {
    poolEnabled: true,
    multiTenant: false,
    floor: "container",
    defaultEntryId: "node-22",
    entries: [NODE, PYTHON, LEGACY],
    rejected: [],
    sizeClasses: [
      {
        id: "small",
        label: "S",
        cpuMillis: 1000,
        memoryMib: 2048,
        ephemeralStorageMib: 1,
        volumeMib: 1,
      },
      {
        id: "medium",
        label: "M",
        cpuMillis: 4000,
        memoryMib: 8192,
        ephemeralStorageMib: 1,
        volumeMib: 1,
      },
      {
        id: "gpu-1",
        label: "GPU",
        cpuMillis: 8000,
        memoryMib: 32768,
        ephemeralStorageMib: 1,
        volumeMib: 1,
        gpu: { count: 1, resourceName: "nvidia.com/gpu" },
      },
    ],
    egressPresets: [
      { id: "github", label: "GitHub", domains: ["github.com"] },
      { id: "npm-mirror", label: "npm", domains: ["registry.npmmirror.com"] },
    ],
    bundle: {
      current: { digest: digest("b"), releaseTag: "v1.2.0" },
      retained: [{ digest: digest("c"), releaseTag: "v1.1.0" }],
    },
    ...over,
  }
}

const AUTO: ProjectRuntimeSelection = { source: { kind: "auto" }, updatedAt: 1 }
const REPOSITORY = {
  remote: "https://github.com/acme/app",
  commitSha: "ABCDEF0123456789abcdef0123456789abcdef01",
}

async function devcontainerVerdict(): Promise<
  Extract<EnvironmentDeclarationVerdict, { kind: "declared" }>
> {
  const parsed = parseDevcontainer(
    JSON.stringify({
      image: "python:3.12-slim",
      containerEnv: { PIP_INDEX_URL: "https://pypi.tuna.tsinghua.edu.cn/simple" },
      postCreateCommand: ["pip", "install", "-e", "."],
      forwardPorts: [8000],
      remoteUser: "vscode",
    }),
    ".devcontainer/devcontainer.json"
  )
  if (!parsed.ok) throw new Error("fixture does not parse")
  return {
    kind: "declared",
    declaration: parsed.declaration,
    digest: await environmentDeclarationDigest(parsed.declaration),
    notices: [],
  }
}

function approvalFor(
  verdict: Extract<EnvironmentDeclarationVerdict, { kind: "declared" }>,
  over: Partial<EnvironmentApprovalView> = {}
): EnvironmentApprovalView {
  return {
    ref: "device:/Users/me/app",
    declarationDigest: verdict.digest,
    file: verdict.declaration.file,
    path: verdict.declaration.path,
    resolvedImage: {
      registry: verdict.declaration.image.registry,
      repository: verdict.declaration.image.repository,
      digest: digest("d"),
    },
    ...over,
  }
}

function input(over: Partial<ResolveEnvironmentSpecInput> = {}): ResolveEnvironmentSpecInput {
  return {
    projectId: "project-1",
    runtime: AUTO,
    policy: undefined,
    catalog: catalog(),
    surface: "interactive",
    declaration: { kind: "absent" },
    ...over,
  }
}

function resolved(result: EnvironmentSpecResolution) {
  if (result.kind !== "resolved")
    throw new Error(`expected resolved, got ${JSON.stringify(result)}`)
  return result
}

describe("resolveEnvironmentSpec: opt-in and faults", () => {
  it("is off for a project that never selected a runtime, whatever the deployment offers", async () => {
    await expect(resolveEnvironmentSpec(input({ runtime: undefined }))).resolves.toEqual({
      kind: "off",
    })
    await expect(
      resolveEnvironmentSpec(
        input({ runtime: undefined, catalog: catalog({ poolEnabled: false, multiTenant: true }) })
      )
    ).resolves.toEqual({ kind: "off" })
  })

  it("falls back when the pool is off and nothing makes isolation mandatory", async () => {
    await expect(
      resolveEnvironmentSpec(input({ catalog: catalog({ poolEnabled: false }) }))
    ).resolves.toEqual({ kind: "fallback", code: "sandbox_fallback_pool_disabled", notices: [] })
    await expect(
      resolveEnvironmentSpec(input({ catalog: catalog({ bundle: undefined }) }))
    ).resolves.toEqual({
      kind: "fallback",
      code: "sandbox_fallback_bundle_unavailable",
      notices: [],
    })
  })

  it.each([
    ["a multi-tenant Host", { catalog: catalog({ poolEnabled: false, multiTenant: true }) }],
    [
      "a policy that requires a sandbox",
      {
        catalog: catalog({ poolEnabled: false }),
        policy: { requiredRuntimeCapabilities: [], requireSandbox: true },
      },
    ],
    [
      "an explicit isolation minimum",
      {
        catalog: catalog({ poolEnabled: false }),
        runtime: { ...AUTO, isolationMinimum: "container" as const },
      },
    ],
  ])("refuses instead of falling back for %s", async (_name, over) => {
    await expect(resolveEnvironmentSpec(input(over))).resolves.toMatchObject({
      kind: "refused",
      code: "sandbox_pool_disabled",
    })
  })

  it("refuses a missing bundle when isolation is mandatory", async () => {
    await expect(
      resolveEnvironmentSpec(input({ catalog: catalog({ bundle: undefined, multiTenant: true }) }))
    ).resolves.toMatchObject({ kind: "refused", code: "bundle_unavailable" })
  })

  it("refuses a malformed stored selection before reading the catalog", async () => {
    await expect(
      resolveEnvironmentSpec(
        input({
          runtime: { source: { kind: "catalog", catalogEntryId: "Bad Id" }, updatedAt: 1 },
          catalog: catalog({ poolEnabled: false }),
        })
      )
    ).resolves.toEqual({
      kind: "refused",
      code: "runtime_selection_invalid",
      detail: { field: "source.catalogEntryId" },
      notices: [],
    })
  })
})

describe("resolveEnvironmentSpec: precedence", () => {
  it("resolves an explicit catalog entry over an approved declaration", async () => {
    const declaration = await devcontainerVerdict()
    const result = resolved(
      await resolveEnvironmentSpec(
        input({
          runtime: { source: { kind: "catalog", catalogEntryId: "python-3.12" }, updatedAt: 1 },
          declaration,
          approval: approvalFor(declaration),
          repository: REPOSITORY,
        })
      )
    )
    const { spec } = result
    expect(spec).toMatchObject({
      version: 1,
      projectId: "project-1",
      source: { kind: "project-setting", catalogEntryId: "python-3.12" },
      image: {
        registry: "docker.io",
        repository: "library/python",
        digest: digest("2"),
        catalogEntryId: "python-3.12",
      },
      bundle: { digest: digest("b"), releaseTag: "v1.2.0", pinned: false },
      isolation: { minimum: "gvisor" },
      sizeClassId: "medium",
      lifecycle: "persistent",
      user: {},
      containerEnv: {},
      lifecycleCommands: {},
      forwardPorts: [],
      egress: { tier: "allowlist", presetIds: ["github", "npm-mirror"], approvedDomains: [] },
      browserSidecar: false,
    })
    expect(spec).not.toHaveProperty("workspaceConfigDigest")
    await expect(computeEnvironmentSpecDigest(spec)).resolves.toBe(spec.specDigest)
    expect(spec.explain?.steps).toContainEqual({
      layer: "repo-declaration",
      outcome: "skipped",
      code: "overridden_by_project_setting",
      detail: { path: ".devcontainer/devcontainer.json" },
    })
  })

  it("fails closed when the explicit entry is gone or tag-only, even interactively", async () => {
    const declaration = await devcontainerVerdict()
    await expect(
      resolveEnvironmentSpec(
        input({
          runtime: { source: { kind: "catalog", catalogEntryId: "ruby-3" }, updatedAt: 1 },
          declaration,
          approval: approvalFor(declaration),
          repository: REPOSITORY,
        })
      )
    ).resolves.toMatchObject({
      kind: "refused",
      code: "catalog_entry_unavailable",
      detail: { catalogEntryId: "ruby-3" },
    })
    await expect(
      resolveEnvironmentSpec(
        input({
          runtime: { source: { kind: "catalog", catalogEntryId: "legacy-env" }, updatedAt: 1 },
        })
      )
    ).resolves.toMatchObject({ kind: "refused", code: "image_digest_not_pinned" })
  })

  it("resolves an approved devcontainer with the approved digest and its runtime fields", async () => {
    const declaration = await devcontainerVerdict()
    const { spec, notices } = resolved(
      await resolveEnvironmentSpec(
        input({
          declaration,
          approval: approvalFor(declaration),
          repository: REPOSITORY,
          workspaceConfigDigest: "e".repeat(64),
          surface: "unattended",
        })
      )
    )
    expect(notices).toEqual([])
    expect(spec).toMatchObject({
      source: {
        kind: "repo-declaration",
        file: "devcontainer",
        path: ".devcontainer/devcontainer.json",
        remote: "https://github.com/acme/app",
        commitSha: "abcdef0123456789abcdef0123456789abcdef01",
        declarationDigest: declaration.digest,
        approvalRef: "device:/Users/me/app",
      },
      image: { registry: "docker.io", repository: "library/python", digest: digest("d") },
      sizeClassId: "small",
      isolation: { minimum: "container" },
      user: { declared: { name: "vscode", from: "remoteUser" } },
      containerEnv: { PIP_INDEX_URL: "https://pypi.tuna.tsinghua.edu.cn/simple" },
      lifecycleCommands: { postCreate: { kind: "argv", argv: ["pip", "install", "-e", "."] } },
      forwardPorts: [{ port: 8000 }],
      workspaceConfigDigest: "e".repeat(64),
    })
    expect(spec.image).not.toHaveProperty("catalogEntryId")
  })

  it("merges the project's allowlist with an inline declaration's egress domains", async () => {
    const block = parseWorkspaceEnvironmentBlock({
      image: "ghcr.io/acme/dev@" + digest("f"),
      egressDomains: ["pypi.org", "Registry.Acme.dev"],
    })
    if (!block.ok || block.block.kind !== "inline") throw new Error("fixture does not parse")
    const verdict = {
      kind: "declared" as const,
      declaration: block.block.declaration,
      digest: await environmentDeclarationDigest(block.block.declaration),
      notices: [],
    }
    const { spec } = resolved(
      await resolveEnvironmentSpec(
        input({
          policy: { requiredRuntimeCapabilities: [], allowedDomains: ["PyPI.org", "*.npmjs.org"] },
          runtime: { ...AUTO, egressPresetIds: ["github"] },
          declaration: verdict,
          approval: approvalFor(verdict, {
            ref: "apr_01",
            resolvedImage: { registry: "ghcr.io", repository: "acme/dev", digest: digest("f") },
          }),
          repository: REPOSITORY,
        })
      )
    )
    expect(spec.egress).toEqual({
      tier: "allowlist",
      presetIds: ["github"],
      approvedDomains: ["*.npmjs.org", "pypi.org", "registry.acme.dev"],
    })
    expect(spec.source).toMatchObject({ file: "workspace-json", approvalRef: "apr_01" })
    expect(spec.user).toEqual({})
  })

  it("uses the deployment default when the repository declares nothing", async () => {
    const { spec } = resolved(await resolveEnvironmentSpec(input()))
    expect(spec.source).toEqual({ kind: "deployment-default", catalogEntryId: "node-22" })
    expect(spec.user).toEqual({ declared: { name: "node", from: "image" } })
    expect(spec.sizeClassId).toBe("small")
  })

  it("refuses when there is no usable default", async () => {
    await expect(
      resolveEnvironmentSpec(input({ catalog: catalog({ defaultEntryId: undefined }) }))
    ).resolves.toMatchObject({ kind: "refused", code: "catalog_default_missing" })
    await expect(
      resolveEnvironmentSpec(input({ catalog: catalog({ defaultEntryId: "gone" }) }))
    ).resolves.toMatchObject({ kind: "refused", code: "catalog_default_missing" })
    await expect(
      resolveEnvironmentSpec(input({ catalog: catalog({ defaultEntryId: "legacy-env" }) }))
    ).resolves.toMatchObject({ kind: "refused", code: "image_digest_not_pinned" })
  })
})

describe("resolveEnvironmentSpec: declarations nobody approved", () => {
  it.each([
    ["no approval", undefined, "missing"],
    ["an approval of an older revision", { declarationDigest: "0".repeat(64) }, "changed"],
    ["an approval of another path", { path: ".devcontainer.json" }, "changed"],
    [
      "an approval whose image is a different repository",
      { resolvedImage: { registry: "docker.io", repository: "library/node", digest: digest("d") } },
      "changed",
    ],
  ])("with %s: notices interactively, refuses unattended", async (_name, over, reason) => {
    const declaration = await devcontainerVerdict()
    const approval = over === undefined ? undefined : approvalFor(declaration, over)

    const interactive = resolved(
      await resolveEnvironmentSpec(input({ declaration, approval, repository: REPOSITORY }))
    )
    expect(interactive.spec.source.kind).toBe("deployment-default")
    expect(interactive.notices).toEqual([
      {
        code: "environment_approval_pending",
        detail: { path: ".devcontainer/devcontainer.json", reason },
      },
    ])

    await expect(
      resolveEnvironmentSpec(
        input({ declaration, approval, repository: REPOSITORY, surface: "unattended" })
      )
    ).resolves.toEqual({
      kind: "refused",
      code: "environment_approval_pending",
      detail: { path: ".devcontainer/devcontainer.json", reason },
      notices: [],
    })
  })

  it("does not accept an approval of a different digest than the declaration pinned", async () => {
    const block = parseWorkspaceEnvironmentBlock({ image: "ghcr.io/acme/dev@" + digest("f") })
    if (!block.ok || block.block.kind !== "inline") throw new Error("fixture does not parse")
    const verdict = {
      kind: "declared" as const,
      declaration: block.block.declaration,
      digest: await environmentDeclarationDigest(block.block.declaration),
      notices: [],
    }
    const result = resolved(
      await resolveEnvironmentSpec(
        input({ declaration: verdict, approval: approvalFor(verdict), repository: REPOSITORY })
      )
    )
    expect(result.notices[0]).toMatchObject({ detail: { reason: "changed" } })
  })

  it.each([
    [
      "invalid",
      {
        kind: "invalid",
        path: ".devcontainer/devcontainer.json",
        problems: [{ code: "declaration_image_missing", field: "image" }],
        notices: [],
      },
      {
        code: "environment_declaration_invalid",
        detail: { path: ".devcontainer/devcontainer.json", problems: 1 },
      },
    ],
    ["restricted", { kind: "restricted" }, { code: "environment_declaration_restricted" }],
  ] as const)(
    "an %s declaration notices interactively and refuses unattended",
    async (_name, declaration, notice) => {
      const interactive = resolved(
        await resolveEnvironmentSpec(
          input({ declaration: declaration as EnvironmentDeclarationVerdict })
        )
      )
      expect(interactive.notices).toEqual([notice])
      await expect(
        resolveEnvironmentSpec(
          input({
            declaration: declaration as EnvironmentDeclarationVerdict,
            surface: "unattended",
          })
        )
      ).resolves.toMatchObject({ kind: "refused", ...notice })
    }
  )

  it("will not seal an approved declaration outside a versioned checkout", async () => {
    const declaration = await devcontainerVerdict()
    for (const repository of [
      undefined,
      { ...REPOSITORY, commitSha: "abc123" },
      { ...REPOSITORY, remote: " " },
    ]) {
      const interactive = resolved(
        await resolveEnvironmentSpec(
          input({ declaration, approval: approvalFor(declaration), repository })
        )
      )
      expect(interactive.notices).toEqual([
        {
          code: "environment_declaration_unversioned",
          detail: { path: ".devcontainer/devcontainer.json" },
        },
      ])
      await expect(
        resolveEnvironmentSpec(
          input({
            declaration,
            approval: approvalFor(declaration),
            repository,
            surface: "unattended",
          })
        )
      ).resolves.toMatchObject({ kind: "refused", code: "environment_declaration_unversioned" })
    }
  })
})

describe("resolveEnvironmentSpec: size class, bundle, isolation, egress", () => {
  const onPython = (over: Partial<ProjectRuntimeSelection>) =>
    input({
      runtime: {
        source: { kind: "catalog", catalogEntryId: "python-3.12" },
        updatedAt: 1,
        ...over,
      },
    })

  it("checks the size class exists, is offered and is not a dormant GPU class", async () => {
    await expect(resolveEnvironmentSpec(onPython({ sizeClassId: "huge" }))).resolves.toMatchObject({
      kind: "refused",
      code: "size_class_unknown",
    })
    await expect(resolveEnvironmentSpec(onPython({ sizeClassId: "small" }))).resolves.toMatchObject(
      {
        kind: "refused",
        code: "size_class_not_offered",
        detail: { sizeClassId: "small", catalogEntryId: "python-3.12" },
      }
    )
    await expect(resolveEnvironmentSpec(onPython({ sizeClassId: "gpu-1" }))).resolves.toMatchObject(
      {
        kind: "refused",
        code: "gpu_not_supported",
      }
    )
    await expect(
      resolveEnvironmentSpec(
        input({ catalog: catalog({ defaultEntryId: "gone", entries: [], sizeClasses: [] }) })
      )
    ).resolves.toMatchObject({ kind: "refused", code: "catalog_default_missing" })
  })

  it("pins a retained bundle and refuses a retired one", async () => {
    const pinned = resolved(
      await resolveEnvironmentSpec(
        onPython({ bundlePin: { digest: digest("c"), releaseTag: "v1.1.0" } })
      )
    )
    expect(pinned.spec.bundle).toEqual({ digest: digest("c"), releaseTag: "v1.1.0", pinned: true })
    await expect(
      resolveEnvironmentSpec(onPython({ bundlePin: { digest: digest("9"), releaseTag: "v0.9.0" } }))
    ).resolves.toMatchObject({ kind: "refused", code: "bundle_pin_retired" })
  })

  it("takes the strictest of the Host floor, the entry floor and the project minimum", async () => {
    expect(
      resolved(await resolveEnvironmentSpec(onPython({ isolationMinimum: "container" }))).spec
        .isolation
    ).toEqual({
      minimum: "gvisor",
    })
    expect(
      resolved(await resolveEnvironmentSpec(onPython({ isolationMinimum: "vm" }))).spec.isolation
    ).toEqual({
      minimum: "vm",
    })
    expect(
      resolved(await resolveEnvironmentSpec(input({ catalog: catalog({ floor: "vm" }) }))).spec
        .isolation
    ).toEqual({ minimum: "vm" })
  })

  it("carries lifecycle and sidecar choices", async () => {
    const { spec } = resolved(
      await resolveEnvironmentSpec(onPython({ lifecycle: "ephemeral", browserSidecar: true }))
    )
    expect(spec).toMatchObject({ lifecycle: "ephemeral", browserSidecar: true })
  })

  it("lists nothing when egress is off and refuses unknown presets or bad domains", async () => {
    const off = resolved(
      await resolveEnvironmentSpec(
        input({
          policy: { requiredRuntimeCapabilities: [], network: "off", allowedDomains: ["pypi.org"] },
        })
      )
    )
    expect(off.spec.egress).toEqual({ tier: "off", presetIds: [], approvedDomains: [] })

    const open = resolved(
      await resolveEnvironmentSpec(
        input({ policy: { requiredRuntimeCapabilities: [], network: "on" } })
      )
    )
    expect(open.spec.egress.tier).toBe("on")

    await expect(
      resolveEnvironmentSpec(input({ runtime: { ...AUTO, egressPresetIds: ["pypi-mirror"] } }))
    ).resolves.toMatchObject({
      kind: "refused",
      code: "egress_preset_unknown",
      detail: { presetId: "pypi-mirror" },
    })
    await expect(
      resolveEnvironmentSpec(
        input({ policy: { requiredRuntimeCapabilities: [], allowedDomains: ["10.0.0.8"] } })
      )
    ).resolves.toMatchObject({
      kind: "refused",
      code: "egress_domain_invalid",
      detail: { domain: "10.0.0.8" },
    })
    await expect(
      resolveEnvironmentSpec(
        input({
          policy: {
            requiredRuntimeCapabilities: [],
            allowedDomains: Array.from({ length: 257 }, (_, index) => `d${index}.example.com`),
          },
        })
      )
    ).resolves.toMatchObject({
      kind: "refused",
      code: "egress_domain_limit",
      detail: { count: 257 },
    })
  })

  it("records every layer in the explain trace, outside the digest", async () => {
    const { spec } = resolved(await resolveEnvironmentSpec(input()))
    expect(spec.explain?.steps.map((step) => step.layer)).toEqual([
      "deployment-default",
      "size-class",
      "bundle",
      "isolation",
      "user",
      "egress",
    ])
    const { explain: _explain, ...withoutExplain } = spec
    await expect(computeEnvironmentSpecDigest(withoutExplain)).resolves.toBe(spec.specDigest)
  })
})

describe("image users and device approvals", () => {
  it.each([
    [undefined, undefined],
    ["", undefined],
    ["node", { name: "node", from: "image" }],
    ["node:staff", { name: "node", from: "image" }],
    ["1000:1000", { uid: 1000, from: "image" }],
    ["4294967295", undefined],
    ["Build User", undefined],
  ])("parses the image user %p", (value, expected) => {
    expect(parseImageUser(value)).toEqual(expected)
  })

  it("references the trust-row key, hashing one too long or unprintable for a spec id", async () => {
    await expect(deviceApprovalRef("/Users/me/app")).resolves.toBe("device:/Users/me/app")
    await expect(deviceApprovalRef(`/${"a".repeat(300)}`)).resolves.toMatch(
      /^device:sha256:[0-9a-f]{64}$/
    )
    await expect(deviceApprovalRef("/tmp/a\nb")).resolves.toMatch(/^device:sha256:/)
    // 84 CJK characters are 252 bytes: short in UTF-16 units, too long for Rust's byte limit.
    await expect(deviceApprovalRef(`/${"项".repeat(84)}`)).resolves.toMatch(/^device:sha256:/)
  })

  it("maps a trust row's approval, and nothing without a key or an approval", async () => {
    const approved = {
      declarationDigest: "a".repeat(64),
      file: "devcontainer" as const,
      path: ".devcontainer.json",
      resolvedImage: { registry: "docker.io", repository: "library/node", digest: digest("1") },
      approvedAt: 5,
    }
    await expect(deviceApprovalView("/repo", approved)).resolves.toEqual({
      ref: "device:/repo",
      declarationDigest: approved.declarationDigest,
      file: "devcontainer",
      path: ".devcontainer.json",
      resolvedImage: approved.resolvedImage,
    })
    await expect(deviceApprovalView(null, approved)).resolves.toBeUndefined()
    await expect(deviceApprovalView("/repo", undefined)).resolves.toBeUndefined()
  })
})
