import { z } from "zod"

export const DEPLOYMENT_TARGET_API_VERSION = "deploy.cognia.dev/v1alpha1" as const

const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
const credentialRef = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
const url = z.string().url().max(2048)
const scope = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9:._/-]+$/)

const controllerSchema = z
  .object({
    url,
    credentialRef,
  })
  .strict()

const identitySchema = z
  .object({
    provider: z.literal("oidc"),
    issuer: url,
    audience: z.string().min(1).max(2048),
    tenantClaim: identifier,
    scopes: z
      .object({
        read: scope,
        operate: scope,
        admin: scope,
      })
      .strict(),
  })
  .strict()

const objectStoreSchema = z
  .object({
    provider: z.literal("s3-compatible"),
    endpoint: url,
    region: z.string().min(1).max(128),
    bucket: z.string().min(3).max(255),
    pathStyle: z.boolean(),
    credentialRef,
  })
  .strict()

const snapshotSchema = z.discriminatedUnion("provider", [
  z
    .object({
      provider: z.literal("kubernetes-csi"),
      className: identifier,
    })
    .strict(),
  z
    .object({
      provider: z.literal("external-command"),
      adapterRef: credentialRef,
    })
    .strict(),
  z.object({ provider: z.literal("none") }).strict(),
])

const tlsSchema = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("ingress"), secretRef: credentialRef }).strict(),
  z.object({ provider: z.literal("acme-http01") }).strict(),
  z.object({ provider: z.literal("acme-dns01"), credentialRef }).strict(),
  z.object({ provider: z.literal("existing"), secretRef: credentialRef }).strict(),
])

const secretSchema = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("file"), rootRef: credentialRef }).strict(),
  z.object({ provider: z.literal("kubernetes"), rootRef: credentialRef }).strict(),
  z.object({ provider: z.literal("vault"), rootRef: credentialRef }).strict(),
  z.object({ provider: z.literal("aws-secrets-manager"), rootRef: credentialRef }).strict(),
])

const imagesSchema = z
  .object({
    server: z.string().min(1).max(512),
    runner: z.string().min(1).max(512),
    workspaceRuntime: z.string().min(1).max(512),
  })
  .strict()

export const deploymentTargetSchema = z
  .object({
    apiVersion: z.literal(DEPLOYMENT_TARGET_API_VERSION),
    kind: z.literal("DeploymentTarget"),
    metadata: z
      .object({
        id: identifier,
        label: z.string().min(1).max(128),
      })
      .strict(),
    spec: z
      .object({
        topology: z.enum(["compose", "kubernetes"]),
        publicUrl: url,
        controller: controllerSchema,
        identity: identitySchema,
        objectStore: objectStoreSchema,
        snapshots: snapshotSchema,
        tls: tlsSchema,
        secrets: secretSchema,
        images: imagesSchema,
      })
      .strict(),
  })
  .strict()

export type DeploymentTarget = z.infer<typeof deploymentTargetSchema>

export function parseDeploymentTarget(input: unknown): DeploymentTarget {
  return deploymentTargetSchema.parse(input)
}

const DIGEST_IMAGE = /@sha256:[a-fA-F0-9]{64}$/

export function productionCertificationIssues(target: DeploymentTarget): string[] {
  const issues: string[] = []
  for (const [name, image] of Object.entries(target.spec.images)) {
    if (!DIGEST_IMAGE.test(image)) {
      issues.push(`images.${name} must use an immutable sha256 digest`)
    }
  }
  if (target.spec.snapshots.provider === "none") {
    issues.push("snapshots.provider must be configured for production certification")
  }
  return issues
}
