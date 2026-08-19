/**
 * Form model for the deployment wizard.
 *
 * Pure and separate from the component because the interesting part is not the
 * inputs — it is the mapping from a `DeploymentTarget` validation failure back
 * to the step and field that caused it. The previous wizard rendered thirty-odd
 * inputs on a single sheet and answered every mistake with the raw `ZodError`
 * text at the bottom, which named a path like `spec.objectStore.bucket` and
 * left the reader to find it.
 */

import { z } from "zod"

import {
  DEPLOYMENT_TARGET_API_VERSION,
  deploymentTargetSchema,
  productionCertificationIssues,
  type DeploymentTarget,
} from "./deployment-target"

export type DeploymentTopology = "compose" | "kubernetes"
export type SnapshotProvider = "kubernetes-csi" | "external-command" | "none"
export type SecretProvider = "file" | "kubernetes" | "vault" | "aws-secrets-manager"
export type TlsProvider = "ingress" | "existing" | "acme-http01" | "acme-dns01"

export interface DeploymentFormState {
  id: string
  label: string
  topology: DeploymentTopology
  controllerUrl: string
  controllerCredentialRef: string
  publicUrl: string
  oidcIssuer: string
  oidcAudience: string
  tenantClaim: string
  scopeRead: string
  scopeOperate: string
  scopeAdmin: string
  objectStoreEndpoint: string
  objectStoreRegion: string
  objectStoreBucket: string
  objectStorePathStyle: boolean
  objectStoreCredentialRef: string
  snapshotProvider: SnapshotProvider
  snapshotRef: string
  secretProvider: SecretProvider
  secretRootRef: string
  tlsProvider: TlsProvider
  tlsRef: string
  serverImage: string
  runnerImage: string
  workspaceRuntimeImage: string
  namespace: string
  ingressClassName: string
  storageClassName: string
  runtimeClassName: string
  projectName: string
  deploymentRoot: string
}

/** Keys whose value is a string — the ones a text input can be bound to. */
export type DeploymentFormTextKey = {
  [K in keyof DeploymentFormState]: DeploymentFormState[K] extends string ? K : never
}[keyof DeploymentFormState]

export const INITIAL_DEPLOYMENT_FORM: DeploymentFormState = {
  id: "staging",
  label: "",
  topology: "kubernetes",
  controllerUrl: "",
  controllerCredentialRef: "ops-controller/staging",
  publicUrl: "",
  oidcIssuer: "",
  oidcAudience: "",
  tenantClaim: "organization_id",
  scopeRead: "servers:read",
  scopeOperate: "servers:operate",
  scopeAdmin: "servers:admin",
  objectStoreEndpoint: "",
  objectStoreRegion: "auto",
  objectStoreBucket: "cognia-backups",
  objectStorePathStyle: false,
  objectStoreCredentialRef: "backups/staging",
  snapshotProvider: "kubernetes-csi",
  snapshotRef: "cognia-snapshots",
  secretProvider: "kubernetes",
  secretRootRef: "cognia/staging",
  tlsProvider: "ingress",
  tlsRef: "cognia-server-tls",
  serverImage: "",
  runnerImage: "",
  workspaceRuntimeImage: "",
  namespace: "cognia-staging",
  ingressClassName: "nginx",
  storageClassName: "standard",
  runtimeClassName: "",
  projectName: "cognia",
  deploymentRoot: "/opt/cognia",
}

export const DEPLOYMENT_STEPS = [
  "target",
  "identity",
  "storage",
  "platform",
  "images",
  "review",
] as const

export type DeploymentStep = (typeof DEPLOYMENT_STEPS)[number]

/**
 * Which step owns which part of the schema.
 *
 * Ordered longest-prefix-first so `spec.controller` is not swallowed by a
 * broader entry. Anything unmatched lands on `review`, where the raw issue is
 * still shown — an unroutable path is a schema change this table has not caught
 * up with, and silently hiding it would be worse than showing it late.
 */
const STEP_BY_PATH_PREFIX: ReadonlyArray<readonly [string, DeploymentStep]> = [
  ["spec.controller", "target"],
  ["spec.topology", "target"],
  ["spec.publicUrl", "target"],
  ["metadata", "target"],
  ["spec.identity", "identity"],
  ["spec.objectStore", "storage"],
  ["spec.snapshots", "storage"],
  ["spec.secrets", "storage"],
  ["spec.tls", "storage"],
  ["spec.kubernetes", "platform"],
  ["spec.compose", "platform"],
  ["spec.images", "images"],
]

export function stepForIssuePath(path: string): DeploymentStep {
  for (const [prefix, step] of STEP_BY_PATH_PREFIX) {
    if (path === prefix || path.startsWith(`${prefix}.`)) return step
  }
  return "review"
}

export interface DeploymentFormIssue {
  /** Dotted schema path, e.g. `spec.objectStore.bucket`. */
  path: string
  message: string
  step: DeploymentStep
}

export interface DeploymentFormValidation {
  target: DeploymentTarget | null
  issues: readonly DeploymentFormIssue[]
  /**
   * Blockers to production certification. Distinct from `issues`: the target is
   * valid and deployable, it just would not pass certification — a mutable
   * image tag deploys fine and is still the wrong thing to run in production.
   */
  certificationIssues: readonly string[]
}

function snapshotsFor(state: DeploymentFormState) {
  if (state.snapshotProvider === "none") return { provider: state.snapshotProvider }
  if (state.snapshotProvider === "kubernetes-csi") {
    return { provider: state.snapshotProvider, className: state.snapshotRef }
  }
  return { provider: state.snapshotProvider, adapterRef: state.snapshotRef }
}

function tlsFor(state: DeploymentFormState) {
  if (state.tlsProvider === "ingress" || state.tlsProvider === "existing") {
    return { provider: state.tlsProvider, secretRef: state.tlsRef }
  }
  if (state.tlsProvider === "acme-dns01") {
    return { provider: state.tlsProvider, credentialRef: state.tlsRef }
  }
  return { provider: state.tlsProvider }
}

/**
 * Project the form onto the wire shape.
 *
 * Returns `unknown` rather than `DeploymentTarget`: the whole point is that the
 * form may not be valid yet, and asserting the type here would move the failure
 * from the validator to whichever consumer read a field that is not there.
 */
export function buildDeploymentTarget(state: DeploymentFormState): unknown {
  return {
    apiVersion: DEPLOYMENT_TARGET_API_VERSION,
    kind: "DeploymentTarget",
    metadata: { id: state.id, label: state.label },
    spec: {
      topology: state.topology,
      publicUrl: state.publicUrl,
      // The schema forbids the other topology's block outright, so this is an
      // exclusive choice rather than two optional sections.
      ...(state.topology === "kubernetes"
        ? {
            kubernetes: {
              namespace: state.namespace,
              ingressClassName: state.ingressClassName,
              storageClassName: state.storageClassName,
              ...(state.runtimeClassName ? { runtimeClassName: state.runtimeClassName } : {}),
            },
          }
        : { compose: { projectName: state.projectName, deploymentRoot: state.deploymentRoot } }),
      controller: { url: state.controllerUrl, credentialRef: state.controllerCredentialRef },
      identity: {
        provider: "oidc",
        issuer: state.oidcIssuer,
        audience: state.oidcAudience,
        tenantClaim: state.tenantClaim,
        scopes: { read: state.scopeRead, operate: state.scopeOperate, admin: state.scopeAdmin },
      },
      objectStore: {
        provider: "s3-compatible",
        endpoint: state.objectStoreEndpoint,
        region: state.objectStoreRegion,
        bucket: state.objectStoreBucket,
        pathStyle: state.objectStorePathStyle,
        credentialRef: state.objectStoreCredentialRef,
      },
      snapshots: snapshotsFor(state),
      tls: tlsFor(state),
      secrets: { provider: state.secretProvider, rootRef: state.secretRootRef },
      images: {
        server: state.serverImage,
        runner: state.runnerImage,
        workspaceRuntime: state.workspaceRuntimeImage,
      },
    },
  }
}

/** Validate the form and route every failure to the step that owns it. */
export function validateDeploymentForm(state: DeploymentFormState): DeploymentFormValidation {
  const parsed = deploymentTargetSchema.safeParse(buildDeploymentTarget(state))
  if (parsed.success) {
    return {
      target: parsed.data,
      issues: [],
      certificationIssues: productionCertificationIssues(parsed.data),
    }
  }
  const issues = parsed.error.issues.map((issue: z.core.$ZodIssue) => {
    const path = issue.path.join(".")
    return { path, message: issue.message, step: stepForIssuePath(path) }
  })
  return { target: null, issues, certificationIssues: [] }
}

/** Which steps currently hold at least one problem. */
export function stepsWithIssues(
  issues: readonly DeploymentFormIssue[]
): ReadonlySet<DeploymentStep> {
  return new Set(issues.map((issue) => issue.step))
}

/** Round-trip a validated target back into form state, for the JSON editor. */
export function deploymentFormFromTarget(target: DeploymentTarget): DeploymentFormState {
  const { snapshots, tls } = target.spec
  return {
    id: target.metadata.id,
    label: target.metadata.label,
    topology: target.spec.topology,
    controllerUrl: target.spec.controller.url,
    controllerCredentialRef: target.spec.controller.credentialRef,
    publicUrl: target.spec.publicUrl,
    oidcIssuer: target.spec.identity.issuer,
    oidcAudience: target.spec.identity.audience,
    tenantClaim: target.spec.identity.tenantClaim,
    scopeRead: target.spec.identity.scopes.read,
    scopeOperate: target.spec.identity.scopes.operate,
    scopeAdmin: target.spec.identity.scopes.admin,
    objectStoreEndpoint: target.spec.objectStore.endpoint,
    objectStoreRegion: target.spec.objectStore.region,
    objectStoreBucket: target.spec.objectStore.bucket,
    objectStorePathStyle: target.spec.objectStore.pathStyle,
    objectStoreCredentialRef: target.spec.objectStore.credentialRef,
    snapshotProvider: snapshots.provider,
    snapshotRef:
      snapshots.provider === "kubernetes-csi"
        ? snapshots.className
        : snapshots.provider === "external-command"
          ? snapshots.adapterRef
          : "",
    secretProvider: target.spec.secrets.provider,
    secretRootRef: target.spec.secrets.rootRef,
    tlsProvider: tls.provider,
    tlsRef:
      tls.provider === "ingress" || tls.provider === "existing"
        ? tls.secretRef
        : tls.provider === "acme-dns01"
          ? tls.credentialRef
          : "",
    serverImage: target.spec.images.server,
    runnerImage: target.spec.images.runner,
    workspaceRuntimeImage: target.spec.images.workspaceRuntime,
    // The absent topology's fields keep their defaults rather than emptying:
    // switching topology in the wizard should not hand the user a blank form.
    namespace: target.spec.kubernetes?.namespace ?? INITIAL_DEPLOYMENT_FORM.namespace,
    ingressClassName:
      target.spec.kubernetes?.ingressClassName ?? INITIAL_DEPLOYMENT_FORM.ingressClassName,
    storageClassName:
      target.spec.kubernetes?.storageClassName ?? INITIAL_DEPLOYMENT_FORM.storageClassName,
    runtimeClassName: target.spec.kubernetes?.runtimeClassName ?? "",
    projectName: target.spec.compose?.projectName ?? INITIAL_DEPLOYMENT_FORM.projectName,
    deploymentRoot: target.spec.compose?.deploymentRoot ?? INITIAL_DEPLOYMENT_FORM.deploymentRoot,
  }
}

/**
 * Narrow a capability list to the options this controller reports.
 *
 * The current value is always kept, even when unsupported: dropping it would
 * silently rewrite a choice the operator made, and the schema will reject it at
 * review anyway — with a message that says so.
 */
export function supportedOptions<T extends string>(
  supported: readonly string[] | undefined,
  fallback: readonly T[],
  current: T
): T[] {
  const available = supported?.length
    ? fallback.filter((option) => supported.includes(option))
    : [...fallback]
  return available.includes(current) ? available : [current, ...available]
}
