import { stringify } from "yaml"

import type { DeploymentTarget } from "./deployment-target"

export type RenderedDeployment = RenderedComposeDeployment | RenderedKubernetesDeployment

export interface RenderedComposeDeployment {
  topology: "compose"
  deploymentRoot: string
  projectName: string
  environment: Record<string, string>
}

export interface RenderedKubernetesDeployment {
  topology: "kubernetes"
  files: Record<"namespace.yaml" | "kustomization.yaml", string>
}

const REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export function renderDeploymentTarget(
  target: DeploymentTarget,
  configRevision: string
): RenderedDeployment {
  if (!REVISION_PATTERN.test(configRevision)) {
    throw new Error("configRevision must be a stable identifier")
  }

  if (target.spec.topology === "compose") {
    if (!target.spec.compose) throw new Error("compose configuration is required")
    return {
      topology: "compose",
      deploymentRoot: target.spec.compose.deploymentRoot,
      projectName: target.spec.compose.projectName,
      environment: renderApplicationEnvironment(target, configRevision),
    }
  }

  if (!target.spec.kubernetes) throw new Error("kubernetes configuration is required")
  return {
    topology: "kubernetes",
    files: renderKubernetesFiles(target, configRevision),
  }
}

function renderApplicationEnvironment(
  target: DeploymentTarget,
  configRevision: string
): Record<string, string> {
  return {
    COGNIA_SERVER_IMAGE: target.spec.images.server,
    COGNIA_RUNNER_IMAGE: target.spec.images.runner,
    COGNIA_WORKSPACE_RUNTIME_IMAGE: target.spec.images.workspaceRuntime,
    COGNIA_CONFIG_REVISION: configRevision,
    COGNIA_PUBLIC_URL: new URL(target.spec.publicUrl).toString(),
    COGNIA_LOGTO_ISSUER: new URL(target.spec.identity.issuer).toString(),
    COGNIA_LOGTO_AUDIENCE: target.spec.identity.audience,
    COGNIA_LOGTO_REQUIRED_SCOPES: Object.values(target.spec.identity.scopes).join(" "),
    COGNIA_S3_ENDPOINT: new URL(target.spec.objectStore.endpoint).toString(),
    COGNIA_S3_REGION: target.spec.objectStore.region,
    COGNIA_S3_BUCKET: target.spec.objectStore.bucket,
    COGNIA_S3_PATH_STYLE: String(target.spec.objectStore.pathStyle),
  }
}

function renderKubernetesFiles(
  target: DeploymentTarget,
  configRevision: string
): RenderedKubernetesDeployment["files"] {
  const platform = target.spec.kubernetes
  if (!platform) throw new Error("kubernetes configuration is required")
  const publicUrl = new URL(target.spec.publicUrl)
  const tlsSecretName = kubernetesTlsSecretName(target)
  const statefulSetPatch: Array<Record<string, unknown>> = [
    {
      op: "add",
      path: "/spec/volumeClaimTemplates/0/spec/storageClassName",
      value: platform.storageClassName,
    },
  ]
  if (platform.runtimeClassName) {
    statefulSetPatch.unshift({
      op: "add",
      path: "/spec/template/spec/runtimeClassName",
      value: platform.runtimeClassName,
    })
  }

  const serverImage = splitDigestImage(target.spec.images.server)
  const literals = renderApplicationEnvironment(target, configRevision)
  const configLiterals = [
    `publicUrl=${literals.COGNIA_PUBLIC_URL}`,
    `logtoIssuer=${literals.COGNIA_LOGTO_ISSUER}`,
    `logtoAudience=${literals.COGNIA_LOGTO_AUDIENCE}`,
    `logtoRequiredScopes=${literals.COGNIA_LOGTO_REQUIRED_SCOPES}`,
    `runnerImage=${literals.COGNIA_RUNNER_IMAGE}`,
    `workspaceRuntimeImage=${literals.COGNIA_WORKSPACE_RUNTIME_IMAGE}`,
    `configRevision=${configRevision}`,
    `objectStoreEndpoint=${literals.COGNIA_S3_ENDPOINT}`,
    `objectStoreRegion=${literals.COGNIA_S3_REGION}`,
    `objectStoreBucket=${literals.COGNIA_S3_BUCKET}`,
    `objectStorePathStyle=${literals.COGNIA_S3_PATH_STYLE}`,
    `backupKeyVersion=${configRevision}`,
    `backupPrefix=${target.metadata.id}`,
  ]
  if (target.spec.snapshots.provider === "kubernetes-csi") {
    configLiterals.push(`snapshotClassName=${target.spec.snapshots.className}`)
  }

  const kustomization = {
    apiVersion: "kustomize.config.k8s.io/v1beta1",
    kind: "Kustomization",
    namespace: platform.namespace,
    // The already-enrolled agent applies this application overlay. Including
    // the agent in its own payload would require bootstrapping credentials in
    // Kustomize and could replace the only rollback-capable control plane.
    resources: ["namespace.yaml", "../../base"],
    images: [
      {
        name: "ghcr.io/maxqian888/cognia-server",
        newName: serverImage.name,
        digest: `sha256:${serverImage.digest}`,
      },
    ],
    configMapGenerator: [{ name: "cognia-config", literals: configLiterals }],
    generatorOptions: { disableNameSuffixHash: true },
    patches: [
      {
        target: { kind: "Ingress", name: "cognia-server" },
        patch: stringify([
          { op: "replace", path: "/spec/ingressClassName", value: platform.ingressClassName },
          { op: "replace", path: "/spec/rules/0/host", value: publicUrl.hostname },
          { op: "replace", path: "/spec/tls/0/hosts/0", value: publicUrl.hostname },
          { op: "replace", path: "/spec/tls/0/secretName", value: tlsSecretName },
        ]).trim(),
      },
      {
        target: { kind: "StatefulSet", name: "cognia-server" },
        patch: stringify(statefulSetPatch).trim(),
      },
    ],
  }

  return {
    "namespace.yaml": stringify({
      apiVersion: "v1",
      kind: "Namespace",
      metadata: {
        name: platform.namespace,
        labels: { "cognia.dev/target-id": target.metadata.id },
      },
    }),
    "kustomization.yaml": stringify(kustomization),
  }
}

function kubernetesTlsSecretName(target: DeploymentTarget): string {
  if (target.spec.tls.provider === "ingress" || target.spec.tls.provider === "existing") {
    return target.spec.tls.secretRef
  }
  return `${target.metadata.id}-tls`
}

function splitDigestImage(image: string): { name: string; digest: string } {
  const marker = "@sha256:"
  const markerIndex = image.lastIndexOf(marker)
  if (markerIndex <= 0) throw new Error(`image must be digest-pinned: ${image}`)
  return {
    name: image.slice(0, markerIndex),
    digest: image.slice(markerIndex + marker.length),
  }
}
