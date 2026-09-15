import { readFileSync } from "node:fs"

import { parse, parseAllDocuments } from "yaml"

import { renderDeploymentTarget } from "./deployment-renderer"
import { parseDeploymentTarget } from "./deployment-target"

const digest = (name: string, byte: string) => `ghcr.io/owner/${name}@sha256:${byte.repeat(64)}`

describe("DeploymentTarget renderer", () => {
  it("keeps self-host signaling on the internal service and public ingress path", () => {
    const compose = parse(readFileSync("deploy/compose/docker-compose.yml", "utf8"))
    expect(compose.services["cognia-server"].environment.COGNIA_SIGNALING_URL).toBe(
      "${COGNIA_SIGNALING_URL:-ws://signaling:7892/signaling}"
    )

    const ingress = parse(readFileSync("deploy/k8s/base/ingress.yaml", "utf8"))
    expect(ingress.spec.rules[0].http.paths).toEqual([
      {
        path: "/signaling",
        pathType: "Prefix",
        backend: { service: { name: "signaling", port: { number: 7892 } } },
      },
      {
        path: "/v2/signaling",
        pathType: "Prefix",
        backend: { service: { name: "signaling", port: { number: 7892 } } },
      },
      {
        path: "/",
        pathType: "Prefix",
        backend: { service: { name: "cognia-server", port: { number: 27890 } } },
      },
    ])
  })

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
    expect(overlay.configMapGenerator[0].literals).toEqual(
      expect.arrayContaining([
        "signalingUrl=ws://signaling:7892/signaling",
        "publicSignalingUrl=wss://server.example.com/signaling",
      ])
    )
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
        COGNIA_SIGNALING_URL: "ws://signaling:7892/signaling",
        COGNIA_PUBLIC_SIGNALING_URL: "wss://server.example.com/signaling",
      },
    })
    if (rendered.topology !== "compose") throw new Error("wrong topology")
    expect(JSON.stringify(rendered.environment)).not.toContain("backups/bare-metal")
    expect(JSON.stringify(rendered.environment)).not.toContain("snapshots/zfs")
    expect(rendered.environment).not.toHaveProperty("COGNIA_AGENT_BUNDLE_IMAGE")

    const withBundle = renderDeploymentTarget(
      parseDeploymentTarget({
        ...target,
        spec: {
          ...target.spec,
          images: { ...target.spec.images, agentBundle: digest("cognia-agent-bundle", "d") },
        },
      }),
      "revision-8"
    )
    if (withBundle.topology !== "compose") throw new Error("wrong topology")
    expect(withBundle.environment.COGNIA_AGENT_BUNDLE_IMAGE).toBe(
      digest("cognia-agent-bundle", "d")
    )
    expect(withBundle.environment).not.toHaveProperty("COGNIA_AGENT_BUNDLE_RETAINED_IMAGES")
  })

  it("adds the agent bundle literal to the Kubernetes overlay only when the target has one", () => {
    const base = {
      apiVersion: "deploy.cognia.dev/v1alpha1",
      kind: "DeploymentTarget",
      metadata: { id: "production", label: "Production" },
      spec: {
        topology: "kubernetes",
        publicUrl: "https://server.example.com",
        kubernetes: {
          namespace: "cognia-production",
          ingressClassName: "nginx",
          storageClassName: "standard",
        },
        controller: { url: "https://ops.example.com", credentialRef: "ops/production" },
        identity: {
          provider: "oidc",
          issuer: "https://auth.example.com/oidc",
          audience: "https://server.example.com/api",
          tenantClaim: "organization_id",
          scopes: { read: "servers:read", operate: "servers:operate", admin: "servers:admin" },
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
    }
    const literalsOf = (input: unknown): string[] => {
      const rendered = renderDeploymentTarget(parseDeploymentTarget(input), "revision-1")
      if (rendered.topology !== "kubernetes") throw new Error("wrong topology")
      return parse(rendered.files["kustomization.yaml"]).configMapGenerator[0].literals
    }

    expect(literalsOf(base).some((literal) => literal.startsWith("agentBundle"))).toBe(false)
    expect(
      literalsOf({
        ...base,
        spec: {
          ...base.spec,
          images: { ...base.spec.images, agentBundle: digest("cognia-agent-bundle", "d") },
        },
      })
    ).toContain(`agentBundleImage=${digest("cognia-agent-bundle", "d")}`)
  })

  it("wires the bundle variables into the server manifests the renderer targets", () => {
    const statefulSet = parseAllDocuments(
      readFileSync("deploy/k8s/base/cognia-server.yaml", "utf8")
    )
      .map((document) => document.toJS())
      .find((document) => document?.kind === "StatefulSet")
    const env: Array<{ name: string; valueFrom?: { configMapKeyRef?: { key: string } } }> =
      statefulSet.spec.template.spec.containers[0].env
    const keyFor = (name: string) =>
      env.find((entry) => entry.name === name)?.valueFrom?.configMapKeyRef?.key
    expect(keyFor("COGNIA_AGENT_BUNDLE_IMAGE")).toBe("agentBundleImage")
    expect(keyFor("COGNIA_AGENT_BUNDLE_RETAINED_IMAGES")).toBe("agentBundleRetainedImages")

    const production = parse(readFileSync("deploy/compose/compose.production.yaml", "utf8"))
    expect(production.services["cognia-server"].environment).toMatchObject({
      COGNIA_AGENT_BUNDLE_IMAGE: "${COGNIA_AGENT_BUNDLE_IMAGE:-}",
      COGNIA_AGENT_BUNDLE_RETAINED_IMAGES: "${COGNIA_AGENT_BUNDLE_RETAINED_IMAGES:-}",
    })
  })
})
