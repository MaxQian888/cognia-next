"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import {
  declarationReader,
  environmentApprovalApprove,
  environmentApprovalList,
  environmentApprovalRevoke,
  environmentDeclarationRead,
  environmentDriverStatus,
  environmentEgressGrantCreate,
  environmentImageInspect,
  fetchEnvironmentCatalog,
  isPoolDisabled,
  type ApprovalRecord,
  type DeclarationReadResult,
  type DriverStatus,
} from "@/lib/project-environment/environment-client"
import { declarationRuntimeFieldsDigest } from "@/lib/project-environment/environment-spec-digest"
import { canonicalImageReference } from "@/lib/project-environment/image-reference"
import {
  readEnvironmentDeclaration,
  type EnvironmentDeclarationVerdict,
} from "@/lib/project-environment/read-environment-declaration"
import type { SandboxPlacementOutcome } from "@/lib/sandbox/environment-placement"
import {
  defaultRunEnvironmentSources,
  prepareRunEnvironment,
  type RunEnvironmentRequest,
  type RunEnvironmentSources,
} from "@/lib/sandbox/run-environment"
import type { EnvironmentCatalogView } from "@/types/sandbox/environment-catalog"
import type { ProjectEnvironmentPolicy, ProjectRuntimeSelection } from "@/types/project-environment"

/**
 * Everything the project's "Runtime environment" panel reads and writes
 * (ADR-0182).
 *
 * # Why the preview runs the real resolver
 *
 * The panel shows what WOULD happen for the selection currently in the form,
 * and the only trustworthy answer to that is the resolver a run uses. So the
 * draft is fed to `prepareRunEnvironment` through its injected `selection`
 * source — the same code path, with the unsaved selection substituted. A panel
 * that re-implemented precedence would drift from the runs it claims to
 * describe, which is the failure mode this whole seam exists to avoid.
 *
 * Nothing here registers a placement: `prepareRunEnvironment` deliberately has
 * no side effects, and `placeAgentRun` is the only thing that parks one.
 */
export interface ProjectRuntimeEnvironmentState {
  loading: boolean
  /** The deployment switch. False: the panel says so and offers nothing. */
  poolEnabled: boolean
  catalog?: EnvironmentCatalogView
  /** Absent when the Host has no driver to ask, e.g. a browser with no companion. */
  driver?: DriverStatus
  /** The saved selection. `undefined` until the project opts in. */
  saved: ProjectRuntimeSelection | undefined
  /** What the form holds, which may differ from `saved`. */
  draft: ProjectRuntimeSelection | undefined
  /** What a run would do with `draft`, resolved by the real resolver. */
  preview?: SandboxPlacementOutcome
  /** The declaration files the Host found, unparsed. */
  files?: DeclarationReadResult
  /** The parsed verdict for those files. */
  declaration: EnvironmentDeclarationVerdict
  approvals: ApprovalRecord[]
  /** A refusal the panel itself hit, already localized by the Host. */
  error?: string
  busy: boolean
}

export interface UseProjectRuntimeEnvironmentInput {
  projectId: string
  executionRoot: string
  project: RunEnvironmentRequest["project"]
  /** The enabled definition's saved selection and policy. */
  saved: ProjectRuntimeSelection | undefined
  policy: ProjectEnvironmentPolicy | undefined
  /** The checkout's coordinates, for the approval record. */
  repository?: { remote: string; commitSha: string }
  onSave(selection: ProjectRuntimeSelection | undefined): Promise<void> | void
}

export interface ProjectRuntimeEnvironmentActions {
  setDraft(next: ProjectRuntimeSelection | undefined): void
  save(): Promise<void>
  /** Approve the declaration exactly as it reads now. */
  approve(): Promise<void>
  revoke(approvalId: string): Promise<void>
  grantEgress(tier: "off" | "allowlist" | "on", domains: string[]): Promise<void>
  reload(): Promise<void>
}

/** A selection with the deployment's own defaults, for a project opting in. */
export function defaultRuntimeSelection(): ProjectRuntimeSelection {
  return { source: { kind: "auto" }, updatedAt: Date.now() }
}

export function useProjectRuntimeEnvironment(
  input: UseProjectRuntimeEnvironmentInput,
  sources?: RunEnvironmentSources
): ProjectRuntimeEnvironmentState & ProjectRuntimeEnvironmentActions {
  const { projectId, executionRoot, policy, saved } = input
  // The latest input and sources, read at call time. Every callback below
  // would otherwise capture the project's roots, its remote and `onSave` from
  // the render that created it, and a parent re-rendering with new ones would
  // leave the panel acting on stale values.
  const inputRef = useRef(input)
  inputRef.current = input
  const sourcesRef = useRef<RunEnvironmentSources>(sources ?? defaultRunEnvironmentSources())
  if (sources) sourcesRef.current = sources

  const [draft, setDraft] = useState<ProjectRuntimeSelection | undefined>(saved)
  const [state, setState] = useState<
    Omit<ProjectRuntimeEnvironmentState, "saved" | "draft" | "preview">
  >({
    loading: true,
    poolEnabled: false,
    approvals: [],
    declaration: { kind: "absent" },
    busy: false,
  })
  const [preview, setPreview] = useState<SandboxPlacementOutcome | undefined>(undefined)

  // The saved value is the form's origin. Re-seeding on every change would
  // discard what the user is typing, so it only follows a save or a switch to
  // a different project.
  const seeded = useRef<string>("")
  useEffect(() => {
    const key = `${projectId}:${saved?.updatedAt ?? "none"}`
    if (seeded.current === key) return
    seeded.current = key
    setDraft(saved)
  }, [projectId, saved])

  const reload = useCallback(async () => {
    const current = inputRef.current
    const from = sourcesRef.current
    setState((prev) => ({ ...prev, loading: true, error: undefined }))
    let poolEnabled = false
    let catalog: EnvironmentCatalogView | undefined
    let error: string | undefined
    try {
      catalog = await fetchEnvironmentCatalog()
      poolEnabled = catalog.poolEnabled
    } catch (cause) {
      // The pool being off is the ordinary state of a deployment that never
      // opted in, not a failure to report.
      if (!isPoolDisabled(cause)) error = messageOf(cause)
    }

    // Independent of the catalog: a declaration is worth showing even where
    // nothing can be admitted, and the driver answers for itself.
    const [files, driver, approvals] = await Promise.all([
      current.executionRoot
        ? environmentDeclarationRead(current.executionRoot).catch(() => undefined)
        : undefined,
      poolEnabled ? environmentDriverStatus().catch(() => undefined) : undefined,
      poolEnabled
        ? environmentApprovalList({ projectId: current.projectId, pageSize: 200 })
            .then((page) => page.items)
            .catch((): ApprovalRecord[] => [])
        : [],
    ])

    let declaration: EnvironmentDeclarationVerdict = { kind: "absent" }
    if (files) {
      const request = panelRequest(current)
      const readFile = declarationReader(files)
      declaration = await readEnvironmentDeclaration(
        {
          root: current.executionRoot,
          workspaceConfig: await from.workspaceConfig(request, readFile),
          restricted: await from.restricted(request),
        },
        { readFile }
      )
    }

    setState({
      loading: false,
      poolEnabled,
      ...(catalog ? { catalog } : {}),
      ...(driver ? { driver } : {}),
      ...(files ? { files } : {}),
      declaration,
      approvals,
      ...(error ? { error } : {}),
      busy: false,
    })
  }, [])

  useEffect(() => {
    void reload()
  }, [reload, projectId, executionRoot])

  // Resolve the draft through the real resolver, with the unsaved selection
  // substituted for the stored one and the reads this panel already made
  // reused rather than repeated on every keystroke.
  const { loading, catalog, files, approvals } = state
  useEffect(() => {
    if (loading) return
    let cancelled = false
    const previewSources: RunEnvironmentSources = {
      ...sourcesRef.current,
      selection: async () => ({ runtime: draft, policy }),
      catalog: async () => {
        if (!catalog) throw { code: "sandbox_pool_disabled", message: "no catalog" }
        return catalog
      },
      declarationFiles: async () => files ?? { files: [], searched: [] },
      serverApprovals: async () => approvals,
    }
    void prepareRunEnvironment(panelRequest(inputRef.current, "preview"), previewSources)
      .then((outcome) => {
        if (!cancelled) setPreview(outcome)
      })
      .catch(() => {
        if (!cancelled) setPreview(undefined)
      })
    return () => {
      cancelled = true
    }
  }, [draft, policy, loading, catalog, files, approvals])

  const run = useCallback(async (action: () => Promise<void>) => {
    setState((prev) => ({ ...prev, busy: true, error: undefined }))
    try {
      await action()
    } catch (cause) {
      setState((prev) => ({ ...prev, error: messageOf(cause) }))
    } finally {
      setState((prev) => ({ ...prev, busy: false }))
    }
  }, [])

  const save = useCallback(
    () =>
      run(async () => {
        await inputRef.current.onSave(draft)
      }),
    [draft, run]
  )

  const { declaration } = state
  const approve = useCallback(
    () =>
      run(async () => {
        if (declaration.kind !== "declared") return
        const declared = declaration.declaration
        const current = inputRef.current
        // What the person approves is what runs: a tag is resolved to the
        // digest it names right now, and a later push to that tag does not
        // change what this approval authorizes. A declaration that already
        // names a digest is verified against the registry's bytes instead.
        const metadata = await environmentImageInspect(canonicalImageReference(declared.image))
        await environmentApprovalApprove({
          id: `env-approval:${crypto.randomUUID()}`,
          projectId: current.projectId,
          // Sent as the checkout reports it; the Host states the canonical
          // form, which is what a run looks the approval up by.
          normalizedRemote: current.repository?.remote ?? "",
          path: declared.path,
          // Keyed on the declaration's own digest, so an edited file needs a
          // new approval rather than inheriting this one.
          declarationDigest: declaration.digest,
          resolvedImage: {
            registry: metadata.registry,
            repository: metadata.repository,
            digest: metadata.digest,
          },
          runtimeFieldsDigest: await declarationRuntimeFieldsDigest(declared),
        })
        await reload()
      }),
    [declaration, reload, run]
  )

  const revoke = useCallback(
    (approvalId: string) =>
      run(async () => {
        await environmentApprovalRevoke(approvalId)
        await reload()
      }),
    [reload, run]
  )

  const grantEgress = useCallback(
    (tier: "off" | "allowlist" | "on", domains: string[]) =>
      run(async () => {
        await environmentEgressGrantCreate({
          id: `egress-grant:${crypto.randomUUID()}`,
          projectId: inputRef.current.projectId,
          tier,
          domains,
        })
        await reload()
      }),
    [reload, run]
  )

  return useMemo(
    () => ({
      ...state,
      saved,
      draft,
      ...(preview ? { preview } : {}),
      setDraft,
      save,
      approve,
      revoke,
      grantEgress,
      reload,
    }),
    [state, saved, draft, preview, save, approve, revoke, grantEgress, reload]
  )
}

function panelRequest(
  input: UseProjectRuntimeEnvironmentInput,
  agentId = "panel"
): RunEnvironmentRequest {
  return {
    agentId,
    projectId: input.projectId,
    project: input.project,
    executionRoot: input.executionRoot,
    // The panel is a person looking at it, so an unapproved declaration falls
    // through with a notice rather than refusing — which is what they need to
    // see in order to approve it.
    surface: "interactive",
    ...(input.repository ? { repository: input.repository } : {}),
  }
}

function messageOf(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  if (cause !== null && typeof cause === "object" && "message" in cause) {
    return String((cause as { message: unknown }).message)
  }
  return String(cause)
}
