import { parse } from "yaml"

import { renderDeploymentTarget } from "./deployment-renderer"
import { parseDeploymentTarget } from "./deployment-target"

const digest = (name: string, byte: string) => `ghcr.io/owner/${name}@sha256:${byte.repeat(64)}`

describe("DeploymentTarget renderer", () => {
  it("renders a placeholder-free Kubernetes overlay without materializing credentials", () => {
    const target = parseDeploymentTarget({
      apiVersion: "deploy.cognia.dev/v1alpha1",
      kind: "DeploymentTarget",
      metadata: { id: "production", label: "Production" },
      spec: {
        topology: "kubernetes",
        publicUrl: "https://server.example.com",
        kubernetes: {
          namespace: "cognia-production",
          ingressClassName: "private-nginx",
          storageClassName: "encrypted-rwo",
          runtimeClassName: "gvisor",
        },
        controller: {
          url: "https://ops.example.com",
          credentialRef: "ops-controller/production",
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
          credentialRef: "backups/production",
        },
        snapshots: { provider: "kubernetes-csi", className: "cognia-snapshots" },
        tls: { provider: "ingress", secretRef: "cognia-server-tls" },
        secrets: { provider: "kubernetes", rootRef: "cognia/production" },
        images: {
          server: digest("cognia-server", "a"),
          runner: digest("cognia-runner", "b"),
          workspaceRuntime: digest("cognia-workspace-runtime", "c"),
        },
      },
    })

    const rendered = renderDeploymentTarget(target, "revision-42")
    expect(rendered.topology).toBe("kubernetes")
    if (rendered.topology !== "kubernetes") throw new Error("wrong topology")

    const overlay = parse(rendered.files["kustomization.yaml"])
    expect(overlay.namespace).toBe("cognia-production")
    expect(overlay.images[0]).toMatchObject({
      name: "ghcr.io/maxqian888/cognia-server",
      newName: "ghcr.io/owner/cognia-server",
      digest: `sha256:${"a".repeat(64)}`,
    })
    expect(rendered.files["kustomization.yaml"]).toContain("private-nginx")
    expect(rendered.files["kustomization.yaml"]).toContain("encrypted-rwo")
    expect(rendered.files["kustomization.yaml"]).toContain("cognia-snapshots")
    expect(rendered.files["kustomization.yaml"]).toContain("revision-42")
    expect(overlay.resources).toEqual(["namespace.yaml", "../../base"])
    expect(rendered.files["kustomization.yaml"]).not.toContain("deploy-agent")
    expect(Object.values(rendered.files).join("\n")).not.toMatch(/REPLACE_|\.invalid|latest/)
    expect(Object.values(rendered.files).join("\n")).not.toContain("backups/production")
    expect(Object.values(rendered.files).join("\n")).not.toContain("ops-controller/production")
  })

  it("renders Compose release values and keeps secret refs out of the environment", () => {
    const target = parseDeploymentTarget({
      apiVersion: "deploy.cognia.dev/v1alpha1",
      kind: "DeploymentTarget",
      metadata: { id: "bare-metal", label: "Bare metal" },
      spec: {
        topology: "compose",
        publicUrl: "https://server.example.com",
        compose: { projectName: "cognia-prod", deploymentRoot: "/opt/cognia" },
        controller: { url: "https://ops.example.com", credentialRef: "ops/bare-metal" },
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
          pathStyle: true,
          credentialRef: "backups/bare-metal",
        },
        snapshots: { provider: "external-command", adapterRef: "snapshots/zfs" },
        tls: { provider: "existing", secretRef: "tls/server" },
        secrets: { provider: "file", rootRef: "/run/cognia/secrets" },
        images: {
          server: digest("cognia-server", "a"),
          runner: digest("cognia-runner", "b"),
          workspaceRuntime: digest("cognia-workspace-runtime", "c"),
        },
      },
    })

    const rendered = renderDeploymentTarget(target, "revision-8")
    expect(rendered).toMatchObject({
      topology: "compose",
      deploymentRoot: "/opt/cognia",
      projectName: "cognia-prod",
      environment: {
        COGNIA_CONFIG_REVISION: "revision-8",
        COGNIA_PUBLIC_URL: "https://server.example.com/",
      },
    })
    if (rendered.topology !== "compose") throw new Error("wrong topology")
    expect(JSON.stringify(rendered.environment)).not.toContain("backups/bare-metal")
    expect(JSON.stringify(rendered.environment)).not.toContain("snapshots/zfs")
  })
})
