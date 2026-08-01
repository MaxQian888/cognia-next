import { parseDeploymentTarget, productionCertificationIssues } from "./deployment-target"

const validTarget = {
  apiVersion: "deploy.cognia.dev/v1alpha1",
  kind: "DeploymentTarget",
  metadata: { id: "staging", label: "Staging" },
  spec: {
    topology: "kubernetes",
    kubernetes: {
      namespace: "cognia-staging",
      ingressClassName: "nginx",
      storageClassName: "standard-rwo",
      runtimeClassName: "gvisor",
    },
    publicUrl: "https://server.example.com",
    controller: {
      url: "https://ops.example.com",
      credentialRef: "ops-controller/staging",
    },
    identity: {
      provider: "oidc",
      issuer: "https://auth.example.com/oidc",
      audience: "https://server.example.com/api",
      tenantClaim: "organization_id",
      scopes: {
        read: "servers:read",
        operate: "servers:operate",
        admin: "servers:admin",
      },
    },
    objectStore: {
      provider: "s3-compatible",
      endpoint: "https://s3.example.com",
      region: "auto",
      bucket: "cognia-backups",
      pathStyle: false,
      credentialRef: "backups/staging",
    },
    snapshots: { provider: "kubernetes-csi", className: "cognia-snapshots" },
    tls: { provider: "ingress", secretRef: "cognia-server-tls" },
    secrets: { provider: "kubernetes", rootRef: "cognia/staging" },
    images: {
      server: `ghcr.io/owner/cognia-server@sha256:${"a".repeat(64)}`,
      runner: `ghcr.io/owner/cognia-runner@sha256:${"b".repeat(64)}`,
      workspaceRuntime: `ghcr.io/owner/cognia-workspace-runtime@sha256:${"c".repeat(64)}`,
    },
  },
}

describe("DeploymentTarget contract", () => {
  it("accepts a cloud-neutral target and preserves credential references", () => {
    const parsed = parseDeploymentTarget(validTarget)

    expect(parsed.metadata.id).toBe("staging")
    expect(parsed.spec.objectStore.credentialRef).toBe("backups/staging")
    expect(productionCertificationIssues(parsed)).toEqual([])
  })

  it("rejects unknown fields at every object boundary", () => {
    expect(() =>
      parseDeploymentTarget({
        ...validTarget,
        spec: { ...validTarget.spec, cloudProvider: "aws" },
      })
    ).toThrow(/cloudProvider/)

    expect(() =>
      parseDeploymentTarget({
        ...validTarget,
        spec: {
          ...validTarget.spec,
          objectStore: { ...validTarget.spec.objectStore, accessKey: "plaintext-secret" },
        },
      })
    ).toThrow(/accessKey/)
  })

  it("reports non-digest images and incomplete recovery providers", () => {
    const parsed = parseDeploymentTarget({
      ...validTarget,
      spec: {
        ...validTarget.spec,
        images: { ...validTarget.spec.images, server: "ghcr.io/owner/cognia-server:latest" },
        snapshots: { provider: "none" },
      },
    })

    expect(productionCertificationIssues(parsed)).toEqual([
      "images.server must use an immutable sha256 digest",
      "snapshots.provider must be configured for production certification",
    ])
  })

  it("requires topology-specific infrastructure without accepting a mixed target", () => {
    expect(() =>
      parseDeploymentTarget({
        ...validTarget,
        spec: { ...validTarget.spec, kubernetes: undefined },
      })
    ).toThrow(/kubernetes/)

    expect(() =>
      parseDeploymentTarget({
        ...validTarget,
        spec: {
          ...validTarget.spec,
          compose: { projectName: "cognia", deploymentRoot: "/opt/cognia" },
        },
      })
    ).toThrow(/compose/)
  })
})
