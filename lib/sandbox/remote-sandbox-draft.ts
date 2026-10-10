/**
 * The "Remote sandboxes" provider editor's form, as plain data (ADR-0221).
 *
 * A form holds strings; a provider holds numbers, maps and an optional
 * credential source. This module is the one translation between them, and
 * the structural checks the Rust side would refuse anyway
 * (`SandboxProvidersFile::validate`, `E2bProvider::validate`,
 * `KubernetesProvider::validate`), so the editor can name the field before a
 * save round-trip. The Rust validation stays the authority: anything this
 * module lets through and the Host refuses comes back as the save's problem.
 *
 * Lifetimes are edited in minutes. The settings carry seconds, and every
 * bound on them is a whole number of minutes, so nothing is lost either way.
 *
 * A credential is never read back (the view lists which ids have one stored,
 * not the values), so the form's credential field is "replace": empty keeps
 * whatever is stored, text replaces it.
 */

import { providerSecretId } from "@/lib/sandbox/remote-sandboxes-client"
import {
  DEFAULT_SANDBOX_PROVIDER_LIMITS,
  SANDBOX_PROVIDER_LIMIT_BOUNDS,
  type KubernetesEgressMode,
  type RegistryRule,
  type SandboxProviderConfig,
  type SandboxProviderCredentialSource,
  type SandboxProviderKind,
} from "@/types/sandbox/remote-sandboxes"

/** `[a-z0-9][a-z0-9-]{0,31}`, the Rust `is_provider_id`. */
const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,31}$/
const DNS_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/
const TEMPLATE_PREFIX = /^[a-z0-9][a-z0-9_-]{0,31}$/
/** One component of a repository path (`is_valid_path_component`). */
const PATH_COMPONENT = /^[a-z0-9]+((\.|_|__|-+)[a-z0-9]+)*$/
const LABEL_KEY =
  /^([a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*\/)?[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/
const LABEL_VALUE = /^([A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?)?$/

export const DEFAULT_E2B_API_URL = "https://api.e2b.app"
export const DEFAULT_E2B_DOMAIN = "e2b.app"
export const DEFAULT_E2B_TEMPLATE_PREFIX = "cognia"
export const DEFAULT_E2B_TEMPLATE_BUILD_TIMEOUT_SECS = 1800
export const DEFAULT_KUBERNETES_POD_READY_TIMEOUT_SECS = 180

export interface E2bDraft {
  apiUrl: string
  domain: string
  templatePrefix: string
  templateBuildTimeoutSecs: string
  /** One registry host per line (or comma-separated). */
  delegatedRegistries: string
}

export interface KubernetesDraft {
  connection: "inCluster" | "kubeconfig"
  context: string
  namespace: string
  runtimeClassContainer: string
  runtimeClassGvisor: string
  runtimeClassVm: string
  egress: KubernetesEgressMode
  /** One `key=value` per line. */
  nodeSelector: string
  serviceAccountName: string
  podReadyTimeoutSecs: string
}

export interface ProviderDraft {
  kind: SandboxProviderKind
  id: string
  label: string
  /** A credential to store; empty keeps what is stored. */
  credential: string
  /**
   * The credential source the provider had before this edit, kept when the
   * form types no new credential. A provider written by hand may read its
   * credential from the environment or a file; the form does not rewrite
   * that unless a new value is typed.
   */
  existingCredential?: SandboxProviderCredentialSource
  maxConcurrent: string
  maxLifetimeMinutes: string
  idleTimeoutMinutes: string
  e2b: E2bDraft
  kubernetes: KubernetesDraft
}

export type ProviderDraftField =
  | "id"
  | "label"
  | "credential"
  | "maxConcurrent"
  | "maxLifetimeMinutes"
  | "idleTimeoutMinutes"
  | "e2b.apiUrl"
  | "e2b.domain"
  | "e2b.templatePrefix"
  | "e2b.templateBuildTimeoutSecs"
  | "e2b.delegatedRegistries"
  | "kubernetes.namespace"
  | "kubernetes.runtimeClasses"
  | "kubernetes.nodeSelector"
  | "kubernetes.serviceAccountName"
  | "kubernetes.podReadyTimeoutSecs"

export type ProviderDraftProblemCode =
  | "id_invalid"
  | "id_taken"
  | "label_invalid"
  | "credential_required"
  | "out_of_range"
  | "url_invalid"
  | "domain_invalid"
  | "template_prefix_invalid"
  | "registry_invalid"
  | "namespace_invalid"
  | "name_invalid"
  | "node_selector_invalid"

export interface ProviderDraftProblem {
  field: ProviderDraftField
  code: ProviderDraftProblemCode
  /** Bounds for `out_of_range`; the offending entry for list fields. */
  values?: Record<string, string | number>
}

const MINUTE = 60
const LIFETIME_MINUTES = [
  SANDBOX_PROVIDER_LIMIT_BOUNDS.maxLifetimeSecs[0] / MINUTE,
  SANDBOX_PROVIDER_LIMIT_BOUNDS.maxLifetimeSecs[1] / MINUTE,
] as const
const IDLE_MINUTES = [
  SANDBOX_PROVIDER_LIMIT_BOUNDS.idleTimeoutSecs[0] / MINUTE,
  SANDBOX_PROVIDER_LIMIT_BOUNDS.idleTimeoutSecs[1] / MINUTE,
] as const
const TEMPLATE_BUILD_TIMEOUT = [60, 7200] as const
const POD_READY_TIMEOUT = [10, 1800] as const

/** A new provider's form. */
export function emptyProviderDraft(kind: SandboxProviderKind = "e2b"): ProviderDraft {
  return {
    kind,
    id: "",
    label: "",
    credential: "",
    maxConcurrent: String(DEFAULT_SANDBOX_PROVIDER_LIMITS.maxConcurrent),
    maxLifetimeMinutes: String(DEFAULT_SANDBOX_PROVIDER_LIMITS.maxLifetimeSecs / MINUTE),
    idleTimeoutMinutes: String(DEFAULT_SANDBOX_PROVIDER_LIMITS.idleTimeoutSecs / MINUTE),
    e2b: {
      apiUrl: DEFAULT_E2B_API_URL,
      domain: DEFAULT_E2B_DOMAIN,
      templatePrefix: DEFAULT_E2B_TEMPLATE_PREFIX,
      templateBuildTimeoutSecs: String(DEFAULT_E2B_TEMPLATE_BUILD_TIMEOUT_SECS),
      delegatedRegistries: "",
    },
    kubernetes: {
      // A desktop is never inside a cluster, so the form starts outside one.
      connection: "kubeconfig",
      context: "",
      namespace: "",
      runtimeClassContainer: "",
      runtimeClassGvisor: "",
      runtimeClassVm: "",
      egress: "network-policy",
      nodeSelector: "",
      serviceAccountName: "",
      podReadyTimeoutSecs: String(DEFAULT_KUBERNETES_POD_READY_TIMEOUT_SECS),
    },
  }
}

/** The form for an existing provider. The credential field starts empty. */
export function draftFromProvider(provider: SandboxProviderConfig): ProviderDraft {
  const draft = emptyProviderDraft(provider.kind)
  const limits = { ...DEFAULT_SANDBOX_PROVIDER_LIMITS, ...provider.limits }
  const base: ProviderDraft = {
    ...draft,
    id: provider.id,
    label: provider.label ?? "",
    ...(provider.credential ? { existingCredential: provider.credential } : {}),
    maxConcurrent: String(limits.maxConcurrent),
    maxLifetimeMinutes: String(limits.maxLifetimeSecs / MINUTE),
    idleTimeoutMinutes: String(limits.idleTimeoutSecs / MINUTE),
  }
  if (provider.kind === "e2b") {
    const s = provider.settings
    return {
      ...base,
      e2b: {
        apiUrl: s.apiUrl ?? DEFAULT_E2B_API_URL,
        domain: s.domain ?? DEFAULT_E2B_DOMAIN,
        templatePrefix: s.templatePrefix ?? DEFAULT_E2B_TEMPLATE_PREFIX,
        templateBuildTimeoutSecs: String(
          s.templateBuildTimeoutSecs ?? DEFAULT_E2B_TEMPLATE_BUILD_TIMEOUT_SECS
        ),
        delegatedRegistries: (s.delegatedRegistries ?? []).join("\n"),
      },
    }
  }
  const s = provider.settings
  return {
    ...base,
    kubernetes: {
      connection: s.connection,
      context: s.context ?? "",
      namespace: s.namespace,
      runtimeClassContainer: s.runtimeClasses?.container ?? "",
      runtimeClassGvisor: s.runtimeClasses?.gvisor ?? "",
      runtimeClassVm: s.runtimeClasses?.vm ?? "",
      egress: s.egress ?? "network-policy",
      nodeSelector: Object.entries(s.nodeSelector ?? {})
        .map(([key, value]) => `${key}=${value}`)
        .join("\n"),
      serviceAccountName: s.serviceAccountName ?? "",
      podReadyTimeoutSecs: String(
        s.podReadyTimeoutSecs ?? DEFAULT_KUBERNETES_POD_READY_TIMEOUT_SECS
      ),
    },
  }
}

/** Whether a provider of this form reads a credential at all. */
export function draftNeedsCredential(draft: Pick<ProviderDraft, "kind" | "kubernetes">): boolean {
  return draft.kind === "e2b" || draft.kubernetes.connection === "kubeconfig"
}

function lines(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
}

function integer(text: string): number | undefined {
  const trimmed = text.trim()
  return /^\d+$/.test(trimmed) ? Number(trimmed) : undefined
}

function inRange(
  field: ProviderDraftField,
  text: string,
  [min, max]: readonly [number, number],
  problems: ProviderDraftProblem[]
): number | undefined {
  const value = integer(text)
  if (value === undefined || value < min || value > max) {
    problems.push({ field, code: "out_of_range", values: { min, max } })
    return undefined
  }
  return value
}

/** `key=value` lines into a map, or the first line that is not one. */
function parseNodeSelector(text: string): Record<string, string> | { invalid: string } {
  const selector: Record<string, string> = {}
  for (const line of text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")) {
    const at = line.indexOf("=")
    const key = at < 0 ? line : line.slice(0, at).trim()
    const value = at < 0 ? "" : line.slice(at + 1).trim()
    if (at < 0 || !LABEL_KEY.test(key) || key.length > 316 || !LABEL_VALUE.test(value)) {
      return { invalid: line }
    }
    selector[key] = value
  }
  return selector
}

function isDnsSubdomain(value: string): boolean {
  return value.length <= 253 && value.split(".").every((label) => DNS_LABEL.test(label))
}

/**
 * A registry host with an optional port, as `is_valid_registry` reads one:
 * `localhost`, or a dotted host name.
 */
export function isRegistryHost(value: string): boolean {
  const at = value.lastIndexOf(":")
  const host = at < 0 ? value : value.slice(0, at)
  if (at >= 0) {
    const port = value.slice(at + 1)
    if (!/^\d{1,5}$/.test(port) || Number(port) > 65_535) return false
  }
  return host === "localhost" || (host.includes(".") && isDnsSubdomain(host))
}

function apiUrlProblem(text: string): boolean {
  let url: URL
  try {
    url = new URL(text.trim())
  } catch {
    return true
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return true
  return url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== ""
}

export interface ProviderDraftContext {
  /** Ids already configured, the edited one included. */
  existingIds: readonly string[]
  /** The id being edited; absent when adding. */
  editingId?: string
  /** Credential ids with a stored value. */
  storedSecretIds: readonly string[]
}

/** Every problem the form has, in field order. Empty means it can be saved. */
export function validateProviderDraft(
  draft: ProviderDraft,
  context: ProviderDraftContext
): ProviderDraftProblem[] {
  const problems: ProviderDraftProblem[] = []
  const id = draft.id.trim()
  if (!PROVIDER_ID.test(id) || id === "local") {
    problems.push({ field: "id", code: "id_invalid" })
  } else if (id !== context.editingId && context.existingIds.includes(id)) {
    problems.push({ field: "id", code: "id_taken" })
  }
  const label = draft.label.trim()
  if ([...label].length > 64) problems.push({ field: "label", code: "label_invalid" })

  if (draftNeedsCredential(draft) && draft.credential.trim() === "") {
    // Kept only when the provider already has one to keep: a stored secret
    // under its own id, or a hand-written env/file source.
    const kept = draft.existingCredential
    const stored =
      kept !== undefined &&
      (!("secretId" in kept) || context.storedSecretIds.includes(kept.secretId))
    if (!stored) {
      problems.push({ field: "credential", code: "credential_required" })
    }
  }

  inRange(
    "maxConcurrent",
    draft.maxConcurrent,
    SANDBOX_PROVIDER_LIMIT_BOUNDS.maxConcurrent,
    problems
  )
  inRange("maxLifetimeMinutes", draft.maxLifetimeMinutes, LIFETIME_MINUTES, problems)
  inRange("idleTimeoutMinutes", draft.idleTimeoutMinutes, IDLE_MINUTES, problems)

  if (draft.kind === "e2b") {
    const e2b = draft.e2b
    if (apiUrlProblem(e2b.apiUrl)) problems.push({ field: "e2b.apiUrl", code: "url_invalid" })
    const domain = e2b.domain.trim()
    if (!domain.includes(".") || /^[\d.]+$/.test(domain) || !isDnsSubdomain(domain)) {
      problems.push({ field: "e2b.domain", code: "domain_invalid" })
    }
    if (!TEMPLATE_PREFIX.test(e2b.templatePrefix.trim())) {
      problems.push({ field: "e2b.templatePrefix", code: "template_prefix_invalid" })
    }
    inRange(
      "e2b.templateBuildTimeoutSecs",
      e2b.templateBuildTimeoutSecs,
      TEMPLATE_BUILD_TIMEOUT,
      problems
    )
    const badRegistry = lines(e2b.delegatedRegistries).find(
      (registry) => !isRegistryHost(registry.toLowerCase())
    )
    if (badRegistry !== undefined) {
      problems.push({
        field: "e2b.delegatedRegistries",
        code: "registry_invalid",
        values: { entry: badRegistry },
      })
    }
  } else {
    const k8s = draft.kubernetes
    if (!DNS_LABEL.test(k8s.namespace.trim())) {
      problems.push({ field: "kubernetes.namespace", code: "namespace_invalid" })
    }
    const badClass = [k8s.runtimeClassContainer, k8s.runtimeClassGvisor, k8s.runtimeClassVm]
      .map((value) => value.trim())
      .find((value) => value !== "" && !isDnsSubdomain(value))
    if (badClass !== undefined) {
      problems.push({
        field: "kubernetes.runtimeClasses",
        code: "name_invalid",
        values: { entry: badClass },
      })
    }
    const selector = parseNodeSelector(k8s.nodeSelector)
    if ("invalid" in selector && typeof selector.invalid === "string") {
      problems.push({
        field: "kubernetes.nodeSelector",
        code: "node_selector_invalid",
        values: { entry: selector.invalid },
      })
    }
    const account = k8s.serviceAccountName.trim()
    if (account !== "" && !isDnsSubdomain(account)) {
      problems.push({ field: "kubernetes.serviceAccountName", code: "name_invalid" })
    }
    inRange("kubernetes.podReadyTimeoutSecs", k8s.podReadyTimeoutSecs, POD_READY_TIMEOUT, problems)
  }
  return problems
}

export interface ProviderFromDraft {
  provider: SandboxProviderConfig
  /** By secret id: a value to store, or `null` to delete one this edit orphaned. */
  secrets: Record<string, string | null>
}

/**
 * The provider a valid form describes, and the secret writes it needs.
 * `undefined` when the form has problems.
 *
 * A typed credential is stored under the provider's own id
 * (`remote-sandbox:<id>`), and the secret it replaces is deleted. With none
 * typed the provider keeps the source it had, so a renamed provider keeps
 * reading the credential it was given under its old id.
 */
export function providerFromDraft(
  draft: ProviderDraft,
  context: ProviderDraftContext
): ProviderFromDraft | undefined {
  if (validateProviderDraft(draft, context).length > 0) return undefined
  const id = draft.id.trim()
  const label = draft.label.trim()
  const secrets: Record<string, string | null> = {}
  let credential: SandboxProviderCredentialSource | undefined
  const typed = draft.credential.trim()
  const oldSecret =
    draft.existingCredential && "secretId" in draft.existingCredential
      ? draft.existingCredential.secretId
      : undefined

  if (!draftNeedsCredential(draft)) {
    credential = undefined
  } else if (typed !== "") {
    credential = { secretId: providerSecretId(id) }
    // The kubeconfig is YAML: keep its own line structure, only trim the ends.
    secrets[credential.secretId] = typed
  } else {
    credential = draft.existingCredential
  }
  const keptSecret = credential && "secretId" in credential ? credential.secretId : undefined
  if (oldSecret !== undefined && keptSecret !== oldSecret) secrets[oldSecret] = null

  const limits = {
    maxConcurrent: Number(draft.maxConcurrent.trim()),
    maxLifetimeSecs: Number(draft.maxLifetimeMinutes.trim()) * MINUTE,
    idleTimeoutSecs: Number(draft.idleTimeoutMinutes.trim()) * MINUTE,
  }
  const base = {
    id,
    ...(label ? { label } : {}),
    ...(credential ? { credential } : {}),
    limits,
  }

  if (draft.kind === "e2b") {
    const e2b = draft.e2b
    const delegated = [...new Set(lines(e2b.delegatedRegistries).map((r) => r.toLowerCase()))]
    return {
      provider: {
        ...base,
        kind: "e2b",
        settings: {
          apiUrl: e2b.apiUrl.trim(),
          domain: e2b.domain.trim(),
          templatePrefix: e2b.templatePrefix.trim(),
          templateBuildTimeoutSecs: Number(e2b.templateBuildTimeoutSecs.trim()),
          ...(delegated.length > 0 ? { delegatedRegistries: delegated } : {}),
        },
      },
      secrets,
    }
  }

  const k8s = draft.kubernetes
  const runtimeClasses = {
    ...(k8s.runtimeClassContainer.trim() ? { container: k8s.runtimeClassContainer.trim() } : {}),
    ...(k8s.runtimeClassGvisor.trim() ? { gvisor: k8s.runtimeClassGvisor.trim() } : {}),
    ...(k8s.runtimeClassVm.trim() ? { vm: k8s.runtimeClassVm.trim() } : {}),
  }
  const nodeSelector = parseNodeSelector(k8s.nodeSelector) as Record<string, string>
  const kubeContext = k8s.connection === "kubeconfig" ? k8s.context.trim() : ""
  return {
    provider: {
      ...base,
      kind: "kubernetes",
      settings: {
        connection: k8s.connection,
        ...(kubeContext ? { context: kubeContext } : {}),
        namespace: k8s.namespace.trim(),
        ...(Object.keys(runtimeClasses).length > 0 ? { runtimeClasses } : {}),
        egress: k8s.egress,
        ...(Object.keys(nodeSelector).length > 0 ? { nodeSelector } : {}),
        ...(k8s.serviceAccountName.trim()
          ? { serviceAccountName: k8s.serviceAccountName.trim() }
          : {}),
        podReadyTimeoutSecs: Number(k8s.podReadyTimeoutSecs.trim()),
      },
    },
    secrets,
  }
}

export type RegistryRuleProblemCode = "registry_invalid" | "prefix_invalid" | "duplicate"

/**
 * Problems with the registry allowlist, by row index. A repository prefix is
 * empty (the whole registry) or a path of lowercase repository components.
 */
export function validateRegistryRules(
  rules: readonly RegistryRule[]
): Map<number, RegistryRuleProblemCode> {
  const problems = new Map<number, RegistryRuleProblemCode>()
  const seen = new Set<string>()
  rules.forEach((rule, index) => {
    const registry = rule.registry.trim().toLowerCase()
    const prefix = rule.repositoryPrefix.trim()
    if (!isRegistryHost(registry)) {
      problems.set(index, "registry_invalid")
      return
    }
    const path = prefix.replace(/^\/+|\/+$/g, "")
    if (
      path !== "" &&
      (path.length > 255 || !path.split("/").every((c) => PATH_COMPONENT.test(c)))
    ) {
      problems.set(index, "prefix_invalid")
      return
    }
    const key = `${registry}/${path}`
    if (seen.has(key)) problems.set(index, "duplicate")
    seen.add(key)
  })
  return problems
}

/** The allowlist as it is saved: trimmed, registries lowercased. */
export function normalizeRegistryRules(rules: readonly RegistryRule[]): RegistryRule[] {
  return rules.map((rule) => ({
    registry: rule.registry.trim().toLowerCase(),
    repositoryPrefix: rule.repositoryPrefix.trim(),
    ...(rule.insecure ? { insecure: true } : {}),
  }))
}
