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
  z
    .object({
      provider: z.literal("file"),
      rootRef: z.string().min(1).max(1024).startsWith("/"),
    })
    .strict(),
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

const kubernetesName = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$/)

const kubernetesSchema = z
  .object({
    namespace: kubernetesName,
    ingressClassName: kubernetesName,
    storageClassName: kubernetesName,
    runtimeClassName: kubernetesName.optional(),
  })
  .strict()

const composeSchema = z
  .object({
    projectName: z
      .string()
      .min(1)
      .max(63)
      .regex(/^[a-z0-9][a-z0-9_-]*$/),
    deploymentRoot: z.string().min(1).max(1024).startsWith("/"),
  })
  .strict()

const deploymentSpecSchema = z
  .object({
    topology: z.enum(["compose", "kubernetes"]),
    publicUrl: url,
    compose: composeSchema.optional(),
    kubernetes: kubernetesSchema.optional(),
    controller: controllerSchema,
    identity: identitySchema,
    objectStore: objectStoreSchema,
    snapshots: snapshotSchema,
    tls: tlsSchema,
    secrets: secretSchema,
    images: imagesSchema,
  })
  .strict()
  .superRefine((spec, context) => {
    if (spec.topology === "compose") {
      if (!spec.compose) {
        context.addIssue({
          code: "custom",
          path: ["compose"],
          message: "compose configuration is required for compose topology",
        })
      }
      if (spec.kubernetes) {
        context.addIssue({
          code: "custom",
          path: ["kubernetes"],
          message: "kubernetes configuration is not allowed for compose topology",
        })
      }
    } else {
      if (!spec.kubernetes) {
        context.addIssue({
          code: "custom",
          path: ["kubernetes"],
          message: "kubernetes configuration is required for kubernetes topology",
        })
      }
      if (spec.compose) {
        context.addIssue({
          code: "custom",
          path: ["compose"],
          message: "compose configuration is not allowed for kubernetes topology",
        })
      }
    }
  })

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
    spec: deploymentSpecSchema,
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
