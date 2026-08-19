import {
  buildDeploymentTarget,
  deploymentFormFromTarget,
  INITIAL_DEPLOYMENT_FORM,
  stepForIssuePath,
  stepsWithIssues,
  supportedOptions,
  validateDeploymentForm,
  type DeploymentFormState,
} from "./deployment-form"
import { parseDeploymentTarget } from "./deployment-target"

const digest = (name: string) => `ghcr.io/owner/${name}@sha256:${"a".repeat(64)}`

const complete: DeploymentFormState = {
  ...INITIAL_DEPLOYMENT_FORM,
  label: "Staging",
  controllerUrl: "https://ops.example.com",
  publicUrl: "https://server.example.com",
  oidcIssuer: "https://auth.example.com/oidc",
  oidcAudience: "https://server.example.com/api",
  objectStoreEndpoint: "https://s3.example.com",
  serverImage: digest("cognia-server"),
  runnerImage: digest("cognia-runner"),
  workspaceRuntimeImage: digest("cognia-workspace-runtime"),
}

describe("validateDeploymentForm", () => {
  it("accepts a complete kubernetes target and reports no certification blockers", () => {
    const result = validateDeploymentForm(complete)
    expect(result.issues).toEqual([])
    expect(result.target?.metadata.id).toBe("staging")
    expect(result.certificationIssues).toEqual([])
  })

  it("routes each failure to the step that owns the field", () => {
    const result = validateDeploymentForm({
      ...complete,
      label: "",
      oidcIssuer: "not-a-url",
      objectStoreBucket: "ab",
      serverImage: "",
      namespace: "Not A Namespace",
    })

    const byStep = new Map(result.issues.map((issue) => [issue.path, issue.step]))
    expect(byStep.get("metadata.label")).toBe("target")
    expect(byStep.get("spec.identity.issuer")).toBe("identity")
    expect(byStep.get("spec.objectStore.bucket")).toBe("storage")
    expect(byStep.get("spec.kubernetes.namespace")).toBe("platform")
    expect(byStep.get("spec.images.server")).toBe("images")
    expect(stepsWithIssues(result.issues)).toEqual(
      new Set(["target", "identity", "storage", "platform", "images"])
    )
  })

  it("separates certification blockers from validation failures", () => {
    // A mutable tag and no snapshot provider both deploy fine. They are exactly
    // the things that must not reach production, so they are reported without
    // blocking the deploy.
    const result = validateDeploymentForm({
      ...complete,
      serverImage: "ghcr.io/owner/cognia-server:latest",
      snapshotProvider: "none",
    })
    expect(result.target).not.toBeNull()
    expect(result.issues).toEqual([])
    expect(result.certificationIssues).toEqual([
      "images.server must use an immutable sha256 digest",
      "snapshots.provider must be configured for production certification",
    ])
  })

  it("keeps the compose block out of a kubernetes target and vice versa", () => {
    // The schema rejects the other topology's block outright, so this is the
    // one place the form must not simply emit everything it holds.
    const kubernetes = buildDeploymentTarget(complete) as { spec: Record<string, unknown> }
    expect(kubernetes.spec.compose).toBeUndefined()
    expect(kubernetes.spec.kubernetes).toBeDefined()

    const compose = buildDeploymentTarget({ ...complete, topology: "compose" }) as {
      spec: Record<string, unknown>
    }
    expect(compose.spec.kubernetes).toBeUndefined()
    expect(compose.spec.compose).toEqual({
      projectName: "cognia",
      deploymentRoot: "/opt/cognia",
    })
    expect(validateDeploymentForm({ ...complete, topology: "compose" }).issues).toEqual([])
  })

  it("omits an empty runtime class rather than sending a blank one", () => {
    // `runtimeClassName` is optional but must match the Kubernetes name rule
    // when present — an empty string would fail the regex, not be ignored.
    const built = buildDeploymentTarget({ ...complete, runtimeClassName: "" }) as {
      spec: { kubernetes: Record<string, unknown> }
    }
    expect("runtimeClassName" in built.spec.kubernetes).toBe(false)
    expect(validateDeploymentForm({ ...complete, runtimeClassName: "" }).issues).toEqual([])
  })

  it("shapes each snapshot and TLS provider's discriminated payload", () => {
    for (const [provider, expected] of [
      ["kubernetes-csi", { provider: "kubernetes-csi", className: "cognia-snapshots" }],
      ["external-command", { provider: "external-command", adapterRef: "cognia-snapshots" }],
      ["none", { provider: "none" }],
    ] as const) {
      const built = buildDeploymentTarget({ ...complete, snapshotProvider: provider }) as {
        spec: { snapshots: unknown }
      }
      expect(built.spec.snapshots).toEqual(expected)
    }

    for (const [provider, expected] of [
      ["ingress", { provider: "ingress", secretRef: "cognia-server-tls" }],
      ["existing", { provider: "existing", secretRef: "cognia-server-tls" }],
      ["acme-dns01", { provider: "acme-dns01", credentialRef: "cognia-server-tls" }],
      // HTTP-01 proves the domain over the deployment's own ingress, so it
      // takes no reference at all — sending one is a schema violation.
      ["acme-http01", { provider: "acme-http01" }],
    ] as const) {
      const built = buildDeploymentTarget({ ...complete, tlsProvider: provider }) as {
        spec: { tls: unknown }
      }
      expect(built.spec.tls).toEqual(expected)
    }
  })
})

describe("deploymentFormFromTarget", () => {
  it("round-trips a validated target without losing a field", () => {
    const target = parseDeploymentTarget(buildDeploymentTarget(complete))
    expect(deploymentFormFromTarget(target)).toEqual(complete)
  })

  it("keeps the absent topology's defaults so switching back is not a blank form", () => {
    const target = parseDeploymentTarget(
      buildDeploymentTarget({ ...complete, topology: "compose" })
    )
    const restored = deploymentFormFromTarget(target)
    expect(restored.namespace).toBe(INITIAL_DEPLOYMENT_FORM.namespace)
    expect(restored.ingressClassName).toBe(INITIAL_DEPLOYMENT_FORM.ingressClassName)
  })
})

describe("stepForIssuePath", () => {
  it("prefers the longest matching prefix", () => {
    // `spec.controller` must not be routed by a broader `spec` entry.
    expect(stepForIssuePath("spec.controller.credentialRef")).toBe("target")
    expect(stepForIssuePath("spec.images.runner")).toBe("images")
  })

  it("falls back to review for a path no step claims", () => {
    // A schema change this table has not caught up with still has to surface
    // somewhere rather than vanishing.
    expect(stepForIssuePath("apiVersion")).toBe("review")
    expect(stepForIssuePath("")).toBe("review")
  })
})

describe("supportedOptions", () => {
  it("narrows to what the controller reports", () => {
    expect(supportedOptions(["compose"], ["compose", "kubernetes"], "compose")).toEqual(["compose"])
  })

  it("falls back to every option when the controller reports none", () => {
    expect(supportedOptions(undefined, ["compose", "kubernetes"], "compose")).toEqual([
      "compose",
      "kubernetes",
    ])
    expect(supportedOptions([], ["compose", "kubernetes"], "compose")).toEqual([
      "compose",
      "kubernetes",
    ])
  })

  it("keeps an unsupported current value visible instead of rewriting the choice", () => {
    // Dropping it would silently change what the operator selected; the schema
    // rejects it at review with a message that explains why.
    expect(supportedOptions(["compose"], ["compose", "kubernetes"], "kubernetes")).toEqual([
      "kubernetes",
      "compose",
    ])
  })
})
