/**
 * Resolving a project's runtime environment into an EnvironmentSpec (ADR-0182).
 *
 * Pure: the catalog, the repository's declaration verdict, the approval that
 * applies and the checkout's coordinates all come in as arguments, so every
 * precedence and refusal rule below is a table test. The Host re-checks the
 * sealed spec at admission (`crates/cognia-environment/src/policy.rs`); the
 * resolver's refusals exist so a person sees why before anything is requested,
 * never as the enforcement.
 *
 * # Outcomes
 *
 * - `off` — the project never selected a runtime environment. The run takes
 *   the existing path exactly as before (Q39).
 * - `fallback` — the project opted in, but the deployment cannot sandbox right
 *   now and nothing makes isolation mandatory, so the run takes the existing
 *   path with a visible `sandbox_fallback_*` reason (Q40).
 * - `refused` — running would silently do less than was asked: an explicit
 *   choice that is unavailable, mandatory isolation that cannot be met, or an
 *   unattended run whose repository declaration nobody approved.
 * - `resolved` — a sealed spec.
 *
 * # Precedence
 *
 * An explicit catalog entry beats the repository's declaration, which beats
 * the deployment default. An explicit entry that is unavailable refuses rather
 * than falling through: the project named it. A repository declaration that is
 * unapproved, invalid or unreadable falls through to the default only for an
 * interactive run, with a notice; an unattended run has nobody to tell, so it
 * refuses instead of running an image the repository did not ask for.
 */

import { sha256String } from "@/lib/ocr/hash"
import type { ApprovedEnvironmentDeclaration } from "@/lib/db/trusted-workspaces"
import type { ProjectEnvironmentPolicy, ProjectRuntimeSelection } from "@/types/project-environment"
import type {
  EnvironmentCatalogEntryView,
  EnvironmentCatalogView,
} from "@/types/sandbox/environment-catalog"
import {
  ENVIRONMENT_SPEC_LIMITS,
  strongerIsolationTier,
  type DeclaredUser,
  type DeclarationFile,
  type EgressSpec,
  type EnvironmentResolutionStep,
  type EnvironmentSource,
  type EnvironmentSpec,
  type IsolationTier,
  type PinnedImage,
  type SpecBundle,
  type SpecImage,
} from "@/types/sandbox/environment-spec"

import { isValidEgressDomainPattern, isValidUserName } from "./environment-declaration"
import { sealEnvironmentSpec } from "./environment-spec-digest"
import { isValidImageDigest } from "./image-reference"
import type { EnvironmentDeclarationVerdict } from "./read-environment-declaration"
import { runtimeSelectionProblems } from "./runtime-selection"

/** Who is waiting on the run: a person who can read a notice, or nobody. */
export type ResolutionSurface = "interactive" | "unattended"

/** An approval of a repository declaration, from whichever authority applies. */
export interface EnvironmentApprovalView {
  /** The server approval id on a shared Host, `device:<key>` on a desktop. */
  ref: string
  declarationDigest: string
  file: DeclarationFile
  path: string
  resolvedImage: PinnedImage
}

export interface ResolveEnvironmentSpecInput {
  projectId: string
  runtime: ProjectRuntimeSelection | undefined
  policy: ProjectEnvironmentPolicy | undefined
  catalog: EnvironmentCatalogView
  surface: ResolutionSurface
  /** `readEnvironmentDeclaration`'s verdict for the run's execution root. */
  declaration: EnvironmentDeclarationVerdict
  /** The approval recorded for this project's root, if any. */
  approval?: EnvironmentApprovalView
  /** The checkout a declaration was read from. Absent outside a repository. */
  repository?: { remote: string; commitSha: string }
  /** Set only when the workspace.json whose setup runs in the sandbox is approved. */
  workspaceConfigDigest?: string
}

export type SandboxFallbackCode =
  "sandbox_fallback_pool_disabled" | "sandbox_fallback_bundle_unavailable"

export type EnvironmentRefusalCode =
  | "runtime_selection_invalid"
  | "sandbox_pool_disabled"
  | "bundle_unavailable"
  | "bundle_pin_retired"
  | "catalog_entry_unavailable"
  | "catalog_default_missing"
  | "image_digest_not_pinned"
  | "environment_approval_pending"
  | "environment_declaration_invalid"
  | "environment_declaration_restricted"
  | "environment_declaration_unversioned"
  | "size_class_unknown"
  | "size_class_not_offered"
  | "gpu_not_supported"
  | "egress_preset_unknown"
  | "egress_domain_invalid"
  | "egress_domain_limit"

/** Something the person should see about how their environment was chosen. */
export interface ResolutionNotice {
  code:
    | "environment_approval_pending"
    | "environment_declaration_invalid"
    | "environment_declaration_restricted"
    | "environment_declaration_unversioned"
  detail?: Record<string, string | number | boolean>
}

export type EnvironmentSpecResolution =
  | { kind: "off" }
  | { kind: "fallback"; code: SandboxFallbackCode; notices: ResolutionNotice[] }
  | {
      kind: "refused"
      code: EnvironmentRefusalCode
      detail?: Record<string, string | number | boolean>
      notices: ResolutionNotice[]
    }
  | { kind: "resolved"; spec: EnvironmentSpec; notices: ResolutionNotice[] }

type Detail = Record<string, string | number | boolean>

class Refusal {
  constructor(
    readonly code: EnvironmentRefusalCode,
    readonly detail?: Detail
  ) {}
}

/** The chosen image layer, before the size class, bundle and egress layers run. */
type ChosenSource =
  | {
      kind: "catalog"
      source: EnvironmentSource
      entry: EnvironmentCatalogEntryView
      image: SpecImage
    }
  | {
      kind: "declaration"
      source: EnvironmentSource
      image: SpecImage
      declaration: Extract<EnvironmentDeclarationVerdict, { kind: "declared" }>["declaration"]
    }

export async function resolveEnvironmentSpec(
  input: ResolveEnvironmentSpecInput
): Promise<EnvironmentSpecResolution> {
  const { runtime, catalog } = input
  if (runtime === undefined) return { kind: "off" }

  const notices: ResolutionNotice[] = []
  const steps: EnvironmentResolutionStep[] = []
  try {
    const problems = runtimeSelectionProblems(runtime)
    if (problems.length > 0) {
      throw new Refusal("runtime_selection_invalid", { field: problems[0]!.field })
    }

    const mandatory =
      catalog.multiTenant ||
      input.policy?.requireSandbox === true ||
      runtime.isolationMinimum !== undefined
    if (!catalog.poolEnabled) {
      if (mandatory) throw new Refusal("sandbox_pool_disabled")
      return { kind: "fallback", code: "sandbox_fallback_pool_disabled", notices }
    }
    if (!catalog.bundle) {
      if (mandatory) throw new Refusal("bundle_unavailable")
      return { kind: "fallback", code: "sandbox_fallback_bundle_unavailable", notices }
    }

    const chosen = chooseSource(input, notices, steps)
    const sizeClassId = chooseSizeClass(input, chosen, steps)
    const bundle = chooseBundle(runtime, catalog.bundle, steps)
    const minimum = chooseIsolation(runtime, catalog, chosen, steps)
    const declared = chooseUser(chosen, steps)
    const egress = chooseEgress(input, chosen, steps)

    const declaration = chosen.kind === "declaration" ? chosen.declaration : undefined
    const spec = await sealEnvironmentSpec({
      version: 1,
      projectId: input.projectId,
      source: chosen.source,
      image: chosen.image,
      bundle,
      isolation: { minimum },
      sizeClassId,
      lifecycle: runtime.lifecycle ?? "persistent",
      user: declared ? { declared } : {},
      containerEnv: { ...(declaration?.containerEnv ?? {}) },
      lifecycleCommands: structuredClone(declaration?.lifecycleCommands ?? {}),
      forwardPorts: structuredClone(declaration?.forwardPorts ?? []),
      egress,
      browserSidecar: runtime.browserSidecar ?? false,
      ...(input.workspaceConfigDigest
        ? { workspaceConfigDigest: input.workspaceConfigDigest }
        : {}),
      explain: { steps },
    })
    return { kind: "resolved", spec, notices }
  } catch (error) {
    if (error instanceof Refusal) {
      return {
        kind: "refused",
        code: error.code,
        ...(error.detail ? { detail: error.detail } : {}),
        notices,
      }
    }
    throw error
  }
}

function chooseSource(
  input: ResolveEnvironmentSpecInput,
  notices: ResolutionNotice[],
  steps: EnvironmentResolutionStep[]
): ChosenSource {
  const { runtime, catalog, declaration } = input
  const selection = runtime!.source

  if (selection.kind === "catalog") {
    const entry = pinnedEntry(catalog, selection.catalogEntryId)
    steps.push({
      layer: "project-setting",
      outcome: "chosen",
      code: "catalog_entry_selected",
      detail: { catalogEntryId: entry.id },
    })
    if (declaration.kind === "declared" || declaration.kind === "invalid") {
      steps.push({
        layer: "repo-declaration",
        outcome: "skipped",
        code: "overridden_by_project_setting",
        detail: {
          path: declaration.kind === "declared" ? declaration.declaration.path : declaration.path,
        },
      })
    }
    return {
      kind: "catalog",
      source: { kind: "project-setting", catalogEntryId: entry.id },
      entry,
      image: catalogImage(entry),
    }
  }

  const fromDeclaration = declarationSource(input, notices, steps)
  if (fromDeclaration) return fromDeclaration

  const defaultId = catalog.defaultEntryId
  if (!defaultId) throw new Refusal("catalog_default_missing")
  const entry = pinnedEntry(catalog, defaultId, "catalog_default_missing")
  steps.push({
    layer: "deployment-default",
    outcome: "chosen",
    code: "deployment_default_selected",
    detail: { catalogEntryId: entry.id },
  })
  return {
    kind: "catalog",
    source: { kind: "deployment-default", catalogEntryId: entry.id },
    entry,
    image: catalogImage(entry),
  }
}

/**
 * The repository declaration as the source, `undefined` to fall through to
 * the default. Throws for an unattended run that must not fall through.
 */
function declarationSource(
  input: ResolveEnvironmentSpecInput,
  notices: ResolutionNotice[],
  steps: EnvironmentResolutionStep[]
): ChosenSource | undefined {
  const { declaration, approval, repository } = input

  const fallThrough = (code: ResolutionNotice["code"], detail?: Detail): undefined => {
    steps.push({
      layer: "repo-declaration",
      outcome: "skipped",
      code,
      ...(detail ? { detail } : {}),
    })
    if (input.surface === "unattended") throw new Refusal(code, detail)
    notices.push({ code, ...(detail ? { detail } : {}) })
    return undefined
  }

  switch (declaration.kind) {
    case "absent":
      return undefined
    case "restricted":
      return fallThrough("environment_declaration_restricted")
    case "invalid":
      return fallThrough("environment_declaration_invalid", {
        path: declaration.path,
        problems: declaration.problems.length,
      })
    case "declared":
      break
  }

  const declared = declaration.declaration
  const approvalMatches =
    approval !== undefined &&
    approval.declarationDigest === declaration.digest &&
    approval.path === declared.path &&
    approval.file === declared.file &&
    approval.resolvedImage.registry === declared.image.registry &&
    approval.resolvedImage.repository === declared.image.repository &&
    isValidImageDigest(approval.resolvedImage.digest) &&
    // A declaration that names a digest was approved as exactly that digest.
    (declared.image.digest === undefined || declared.image.digest === approval.resolvedImage.digest)
  if (!approvalMatches) {
    return fallThrough("environment_approval_pending", {
      path: declared.path,
      reason: approval === undefined ? "missing" : "changed",
    })
  }

  const remote = repository?.remote.trim()
  const commitSha = repository?.commitSha.trim()
  if (
    !remote ||
    remote.length > 2048 ||
    !commitSha ||
    !/^([0-9a-f]{40}|[0-9a-f]{64})$/i.test(commitSha)
  ) {
    return fallThrough("environment_declaration_unversioned", { path: declared.path })
  }

  steps.push({
    layer: "repo-declaration",
    outcome: "chosen",
    code: "declaration_approved",
    detail: { path: declared.path, file: declared.file },
  })
  return {
    kind: "declaration",
    source: {
      kind: "repo-declaration",
      file: declared.file,
      path: declared.path,
      remote,
      commitSha: commitSha.toLowerCase(),
      declarationDigest: declaration.digest,
      approvalRef: approval!.ref,
    },
    image: {
      registry: approval!.resolvedImage.registry,
      repository: approval!.resolvedImage.repository,
      digest: approval!.resolvedImage.digest,
    },
    declaration: declared,
  }
}

function pinnedEntry(
  catalog: EnvironmentCatalogView,
  id: string,
  missingCode: EnvironmentRefusalCode = "catalog_entry_unavailable"
): EnvironmentCatalogEntryView {
  const entry = catalog.entries.find((candidate) => candidate.id === id)
  if (!entry) throw new Refusal(missingCode, { catalogEntryId: id })
  if (!entry.image.digest || !isValidImageDigest(entry.image.digest)) {
    throw new Refusal("image_digest_not_pinned", { catalogEntryId: id })
  }
  return entry
}

function catalogImage(entry: EnvironmentCatalogEntryView): SpecImage {
  return {
    registry: entry.image.registry,
    repository: entry.image.repository,
    digest: entry.image.digest!,
    catalogEntryId: entry.id,
  }
}

function chooseSizeClass(
  input: ResolveEnvironmentSpecInput,
  chosen: ChosenSource,
  steps: EnvironmentResolutionStep[]
): string {
  const { runtime, catalog } = input
  const defaultEntry = catalog.entries.find((entry) => entry.id === catalog.defaultEntryId)
  const offered = chosen.kind === "catalog" ? chosen.entry.sizeClassIds : undefined
  const id =
    runtime!.sizeClassId ??
    offered?.[0] ??
    defaultEntry?.sizeClassIds[0] ??
    catalog.sizeClasses[0]?.id
  if (!id) throw new Refusal("size_class_unknown")

  const sizeClass = catalog.sizeClasses.find((candidate) => candidate.id === id)
  if (!sizeClass) throw new Refusal("size_class_unknown", { sizeClassId: id })
  if (offered && !offered.includes(id)) {
    throw new Refusal("size_class_not_offered", {
      sizeClassId: id,
      catalogEntryId: chosen.kind === "catalog" ? chosen.entry.id : "",
    })
  }
  // Dormant by design (ADR-0182): GPU classes are modelled, never admitted.
  if (sizeClass.gpu) throw new Refusal("gpu_not_supported", { sizeClassId: id })

  steps.push({
    layer: "size-class",
    outcome: "chosen",
    code: runtime!.sizeClassId ? "size_class_selected" : "size_class_default",
    detail: { sizeClassId: id },
  })
  return id
}

function chooseBundle(
  runtime: ProjectRuntimeSelection | undefined,
  bundles: NonNullable<EnvironmentCatalogView["bundle"]>,
  steps: EnvironmentResolutionStep[]
): SpecBundle {
  const pin = runtime?.bundlePin
  if (!pin) {
    steps.push({
      layer: "bundle",
      outcome: "chosen",
      code: "bundle_current",
      detail: { releaseTag: bundles.current.releaseTag },
    })
    return { digest: bundles.current.digest, releaseTag: bundles.current.releaseTag, pinned: false }
  }
  const offered = [bundles.current, ...bundles.retained].some(
    (bundle) => bundle.digest === pin.digest && bundle.releaseTag === pin.releaseTag
  )
  if (!offered) throw new Refusal("bundle_pin_retired", { releaseTag: pin.releaseTag })
  steps.push({
    layer: "bundle",
    outcome: "chosen",
    code: "bundle_pinned",
    detail: { releaseTag: pin.releaseTag },
  })
  return { digest: pin.digest, releaseTag: pin.releaseTag, pinned: true }
}

function chooseIsolation(
  runtime: ProjectRuntimeSelection | undefined,
  catalog: EnvironmentCatalogView,
  chosen: ChosenSource,
  steps: EnvironmentResolutionStep[]
): IsolationTier {
  let minimum: IsolationTier = catalog.floor
  if (chosen.kind === "catalog")
    minimum = strongerIsolationTier(minimum, chosen.entry.effectiveFloor)
  const floor = minimum
  if (runtime?.isolationMinimum) minimum = strongerIsolationTier(minimum, runtime.isolationMinimum)
  steps.push({
    layer: "isolation",
    outcome: "chosen",
    code: minimum === floor ? "isolation_floor" : "isolation_project_minimum",
    detail: { minimum, floor },
  })
  return minimum
}

function chooseUser(
  chosen: ChosenSource,
  steps: EnvironmentResolutionStep[]
): DeclaredUser | undefined {
  if (chosen.kind === "declaration" && chosen.declaration.user) {
    steps.push({
      layer: "user",
      outcome: "chosen",
      code: "user_declared",
      detail: { from: chosen.declaration.user.from },
    })
    return { ...chosen.declaration.user }
  }
  const imageUser = chosen.kind === "catalog" ? parseImageUser(chosen.entry.imageUser) : undefined
  steps.push({
    layer: "user",
    outcome: "chosen",
    code: imageUser ? "user_from_image" : "user_tier_default",
  })
  return imageUser
}

/**
 * An OCI config `User` as a declared user. `name:group` and `uid:gid` keep
 * only the user part — the group is the image's business, not the spec's. A
 * value neither grammar accepts is left to the tier default rather than
 * guessed at.
 */
export function parseImageUser(value: string | undefined): DeclaredUser | undefined {
  const user = value?.split(":")[0]?.trim()
  if (!user) return undefined
  if (/^\d+$/.test(user)) {
    const uid = Number(user)
    return uid <= 2 ** 31 - 1 ? { uid, from: "image" } : undefined
  }
  return isValidUserName(user) ? { name: user, from: "image" } : undefined
}

function chooseEgress(
  input: ResolveEnvironmentSpecInput,
  chosen: ChosenSource,
  steps: EnvironmentResolutionStep[]
): EgressSpec {
  const { runtime, policy, catalog } = input
  const tier = policy?.network ?? "allowlist"
  if (tier === "off") {
    steps.push({ layer: "egress", outcome: "chosen", code: "egress_off" })
    return { tier, presetIds: [], approvedDomains: [] }
  }

  const known = new Set(catalog.egressPresets.map((preset) => preset.id))
  const presetIds = runtime?.egressPresetIds ?? catalog.egressPresets.map((preset) => preset.id)
  const unknown = presetIds.find((id) => !known.has(id))
  if (unknown) throw new Refusal("egress_preset_unknown", { presetId: unknown })

  const requested = [
    ...(policy?.allowedDomains ?? []),
    ...(chosen.kind === "declaration" ? chosen.declaration.egressDomains : []),
  ]
  const domains = new Set<string>()
  for (const raw of requested) {
    const domain = raw.trim().toLowerCase()
    if (!isValidEgressDomainPattern(domain)) {
      throw new Refusal("egress_domain_invalid", { domain: raw.slice(0, 256) })
    }
    domains.add(domain)
  }
  if (domains.size > ENVIRONMENT_SPEC_LIMITS.maxEgressDomains) {
    throw new Refusal("egress_domain_limit", { count: domains.size })
  }

  steps.push({
    layer: "egress",
    outcome: "chosen",
    code: tier === "on" ? "egress_open" : "egress_allowlist",
    detail: { presets: presetIds.length, domains: domains.size },
  })
  return { tier, presetIds: [...presetIds], approvedDomains: [...domains].sort() }
}

const MAX_APPROVAL_REF_LENGTH = ENVIRONMENT_SPEC_LIMITS.maxIdLength

/**
 * The `approvalRef` of a desktop approval: `device:` and the trust-row key
 * (the workspace's primary root). A root too long for a spec id — or one with
 * control characters — is referenced by its SHA-256 instead; admission on a
 * desktop only checks the prefix, and the ref is for the audit trail.
 */
export async function deviceApprovalRef(approvalKey: string): Promise<string> {
  const plain = `device:${approvalKey}`
  // Bytes, not UTF-16 units: `spec.rs::validate_id` measures `str::len`.
  const bytes = new TextEncoder().encode(plain).length
  if (bytes <= MAX_APPROVAL_REF_LENGTH && !/[ --]/.test(plain)) {
    return plain
  }
  return `device:sha256:${await sha256String(approvalKey)}`
}

/** A desktop trust row's approval as the resolver's approval view. */
export async function deviceApprovalView(
  approvalKey: string | null | undefined,
  approved: ApprovedEnvironmentDeclaration | undefined
): Promise<EnvironmentApprovalView | undefined> {
  if (!approvalKey || !approved) return undefined
  return {
    ref: await deviceApprovalRef(approvalKey),
    declarationDigest: approved.declarationDigest,
    file: approved.file,
    path: approved.path,
    resolvedImage: approved.resolvedImage,
  }
}
