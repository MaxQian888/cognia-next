"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { useTranslations } from "next-intl"
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  DownloadIcon,
  ExternalLinkIcon,
  FileArchiveIcon,
  PlusIcon,
  SearchIcon,
  Trash2Icon,
  UploadIcon,
  ChevronDownIcon,
  GitFork as GitForkIcon,
} from "lucide-react"
import { toast } from "sonner"
import { usePlatform } from "@/hooks/use-platform"
import { refreshTemplateOwners } from "@/lib/global-search/providers/library"
import { useScopedTemplateCatalog } from "@/hooks/templates/use-scoped-template-catalog"
import {
  TEMPLATE_TABS,
  useTemplateRouteState,
  type TemplateTab,
} from "@/hooks/templates/use-template-route-state"
import { TEMPLATE_SCOPE_TIERS, type TemplateScopeTier } from "@/lib/templates/scope"
import { useProjectStore } from "@/stores/project/project-store"
import type {
  TemplateDefinitionEnvelope,
  TemplateDomain,
  TemplateInputSpec,
  TemplateJson,
  TemplatePlatform,
  TemplateVersionBump,
} from "@/lib/templates/contracts"
import {
  TEMPLATE_CATALOG_ONLY_DOMAINS,
  TEMPLATE_FULL_DOMAINS,
  isTemplateInputId,
  listTemplateTokens,
} from "@/lib/templates/contracts"
import type { InspectedTemplatePackage } from "@/lib/templates/package"
import type {
  TemplateConflictResolution,
  TemplateDerivedUpdatePlan,
  TemplatePackageVerification,
  TemplatePreflightPlan,
  TemplateUpdatePlan,
} from "@/lib/templates/service"
import type { TemplateDerivation } from "@/lib/templates/repository"
import { getTemplateRuntime } from "@/lib/templates/runtime"
import { makeTemplateDraftId } from "@/lib/templates/draft-id"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { FeaturePageHeader } from "@/components/feature-shell/feature-page-header"
import { FeaturePageShell } from "@/components/feature-shell/feature-page-shell"
import { isWorkflowNodeGroupDefinition } from "@/lib/workflow/node-groups/materialize"

import { TemplateBindingField } from "./template-binding-field"
import { TemplateExportDialog, type TemplateExportRequest } from "./template-export-dialog"
import { TemplatePackagesTab } from "./template-packages-tab"
import { TemplateMetadataEditor, type TemplateMetadataDraft } from "./template-metadata-editor"
import { PublishConfirmDialog, type PublishSuggestion } from "./publish-confirm-dialog"
import { InstantiateConfirmDialog } from "./instantiate-confirm-dialog"
import { TemplateInstanceCard } from "./template-instance-card"
import { TemplateDerivedUpdateDialog } from "./template-derived-update-dialog"
import { TemplateOriginCard } from "./template-origin-card"
import { TemplateScopeControl } from "./template-scope-control"
import { TemplateUpdateDialog } from "./template-update-dialog"

/** Domains with a real adapter: these can be authored, published, instantiated. */
const FULL_DOMAINS: TemplateDomain[] = [...TEMPLATE_FULL_DOMAINS]

/**
 * Every domain the filter offers.
 *
 * The six catalog-only domains are searchable projections with no adapter, so
 * they are read-only here, but they render a domain badge and carry i18n
 * labels. Leaving them out of the filter meant half the catalog could be seen
 * on a card and never filtered to.
 */
const FILTERABLE_DOMAINS: TemplateDomain[] = [
  ...TEMPLATE_FULL_DOMAINS,
  ...TEMPLATE_CATALOG_ONLY_DOMAINS,
]

/**
 * Domains that are declared but have nothing behind them.
 *
 * `document` is a catalog-only domain whose reader returns an empty array
 * because no store in the app owns a "document template" to project. Offering
 * it as a plain filter would mean picking it always empties the list with no
 * explanation, which reads as a broken filter rather than an absent feature.
 * Labelled inert instead. See `lib/templates/dormancy.test.ts`.
 */
const INERT_DOMAINS = new Set<TemplateDomain>(["document"])

/**
 * Where a domain's real editor lives.
 *
 * Two of these used to carry `?mode=template-authoring`, a parameter nothing
 * in the repository reads, and `customMode` pointed at `?section=agent`, which
 * is not a `SettingsSectionId` (the catalog has `agents`, `agent-modes` and
 * `agent-runtime`) so the shell silently fell back to AI connections. A link
 * that lands somewhere unrelated is worse than one that lands on the list.
 */
const EDITOR_ROUTES: Record<string, string> = {
  agentTeam: "/settings?section=squads",
  chatTemplate: "/settings?section=chatTemplates",
  workflow: "/workflows",
  subagent: "/me/subagents",
  customMode: "/settings?section=agent-modes",
  character: "/discover?category=characters",
  skill: "/skills",
}

/**
 * Seed payload for a new draft, per domain.
 *
 * The return type is annotated rather than inferred: without it TypeScript
 * unions the seven branch shapes and pads each with the other branches' keys as
 * `name?: undefined`, and a property of type `undefined` is not a `TemplateJson`
 * — so the inferred type could not be assigned to the `payload` field it exists
 * to fill.
 */
function defaultPayload(domain: TemplateDomain, name: string, teamLeadName: string): TemplateJson {
  switch (domain) {
    case "agentTeam":
      return {
        team: { name, description: "", task: "", config: {} },
        lead: { localId: "lead", name: teamLeadName, description: "", config: {} },
        teammates: [],
        tasks: [],
        twinSlots: [],
      }
    case "workflow":
      return { name, nodes: [], edges: [], settings: {}, viewport: { x: 0, y: 0, zoom: 1 } }
    case "subagent":
      return { name, description: "", category: "general", taskTemplate: "", config: {} }
    case "customMode":
      return { name, description: "", type: "custom", tools: [] }
    case "character":
      return { name, systemPrompt: "" }
    case "skill":
      return { name, content: "" }
    default:
      return {}
  }
}

function downloadPackage(bytes: Uint8Array, filename: string): void {
  const blob = new Blob([bytes as BlobPart], { type: "application/zip" })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = filename
  // In the document, and revoked on the next task rather than synchronously:
  // some browsers ignore a click on a detached anchor, and revoking before the
  // download has been handed off cancels it.
  anchor.style.display = "none"
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

export function TemplateStudio() {
  const t = useTranslations("templateStudio")
  const platform = usePlatform()
  const templatePlatform: TemplatePlatform =
    platform === "mobile" ? "mobile" : platform === "web" ? "web" : "desktop"
  const runtime = useMemo(() => getTemplateRuntime(), [])
  // Filters live in the URL, shared with the phone body through
  // `useTemplateRouteState`, so a narrowed catalog is something you can send
  // someone and it opens the same way on either surface.
  const route = useTemplateRouteState()
  const { query, domain, trust, scope: tier } = route
  const { setQuery, setDomain, setTrust, setScope: setTier } = route
  // Scoped, not raw: a definition confined to another workspace is not this
  // workspace's to list, and one this workspace hid should not come back
  // because the Studio asked a different question than the phone did.
  const { definitions, revision, tierOf, owners, hiddenCount } = useScopedTemplateCatalog(
    {
      text: query,
      platform: templatePlatform,
      ...(domain === "all" ? {} : { domain }),
      ...(trust === "all" ? {} : { trust }),
    },
    { tier }
  )
  const activeWorkspaceId = useProjectStore((state) => state.activeProjectId)
  const [allWorkspaceInstances, setAllWorkspaceInstances] = useState(false)
  const instanceScope = useMemo(
    () =>
      allWorkspaceInstances || !activeWorkspaceId ? undefined : { projectId: activeWorkspaceId },
    [allWorkspaceInstances, activeWorkspaceId]
  )
  /**
   * WHICH template is selected lives in `?definition=`, the same param the
   * phone body reads.
   *
   * `?definition=` is how /agent-teams, the workflow settings tab and global
   * search hand a template over, and the Studio used to read it once through
   * its own `useSearchParams` and then keep the answer in a local
   * `selectionKey`. So clicking a card changed nothing in the URL: the desktop
   * selection could not be sent to anyone, and a link opened on a phone and on
   * a laptop meant two different things.
   *
   * WHICH ENVELOPE of that id is a second, narrower question the URL should not
   * carry: one definition id holds a draft and every release published from it,
   * and the row the user clicked is one of them. Pinned locally, and only while
   * it still names the selected id — a stale pin from a previous selection
   * simply stops applying, which is what keeps this from fighting the router's
   * own re-render.
   */
  const selectedId = route.definitionId
  const [pinnedEnvelope, setPinnedEnvelope] = useState<{ id: string; contentHash: string }>()
  const selected = useMemo(() => {
    if (!selectedId) return undefined
    const rows = definitions.filter((definition) => definition.id === selectedId)
    const pinned =
      pinnedEnvelope?.id === selectedId
        ? rows.find((definition) => definition.contentHash === pinnedEnvelope.contentHash)
        : undefined
    return pinned ?? rows[0]
  }, [definitions, selectedId, pinnedEnvelope])

  /**
   * Select a definition, and remember which of its envelopes was clicked.
   *
   * Not memoised: `useTemplateRouteState` returns a fresh object every render,
   * so a `useCallback` over it would be a stable-looking identity that changes
   * anyway.
   */
  const selectEnvelope = (definition: TemplateDefinitionEnvelope) => {
    setPinnedEnvelope({ id: definition.id, contentHash: definition.contentHash })
    route.setDefinitionId(definition.id)
  }
  const [packages, setPackages] = useState<
    Awaited<ReturnType<typeof runtime.repository.listPackages>>
  >([])
  const [instances, setInstances] = useState<
    Awaited<ReturnType<typeof runtime.repository.listInstances>>
  >([])
  // Whether the inspector rail's below-`md` Sheet is showing. Desktop ignores
  // it: the rail is always mounted there.
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [draftName, setDraftName] = useState("")
  const [draftDescription, setDraftDescription] = useState("")
  const [draftDomain, setDraftDomain] = useState<TemplateDomain>("skill")
  const [bindings, setBindings] = useState<Record<string, string>>({})
  const [plan, setPlan] = useState<TemplatePreflightPlan>()
  const [message, setMessage] = useState<string>()
  const [publishSuggestion, setPublishSuggestion] = useState<PublishSuggestion | null>(null)
  const [pendingInstantiate, setPendingInstantiate] = useState<TemplatePreflightPlan>()
  const [updatePlan, setUpdatePlan] = useState<TemplateUpdatePlan>()
  const [derivedPlan, setDerivedPlan] = useState<TemplateDerivedUpdatePlan>()
  const [derivation, setDerivation] = useState<TemplateDerivation>()
  const [upstream, setUpstream] = useState<TemplateDefinitionEnvelope>()
  // Bumped after a merge or a detach so the origin card re-reads. The lineage
  // lives in the repository, not in the catalog the selection comes from, so
  // nothing else would tell this view it changed.
  const [originNonce, setOriginNonce] = useState(0)
  const [pendingImport, setPendingImport] = useState<{
    bytes: Uint8Array
    inspected: InspectedTemplatePackage
  }>()
  const [packageReports, setPackageReports] = useState<Record<string, TemplatePackageVerification>>(
    {}
  )
  const [exportOrigin, setExportOrigin] = useState<TemplateDefinitionEnvelope>()
  const importRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let active = true
    void Promise.all([
      runtime.repository.listPackages(),
      runtime.repository.listInstances(instanceScope),
    ]).then(([nextPackages, nextInstances]) => {
      if (!active) return
      setPackages(nextPackages)
      setInstances(nextInstances)
    })
    return () => {
      active = false
    }
  }, [revision, runtime, instanceScope])

  /**
   * The selected definition's fork lineage, and whether upstream has moved.
   *
   * Read here rather than in the inspector because the lineage is repository
   * state, not catalog state: the selection carries the envelope, and the
   * envelope deliberately does not know where it came from.
   */
  const lineageId = selected?.id
  useEffect(() => {
    let active = true
    // The empty case resolves through the same promise rather than clearing
    // synchronously: a bare setState in an effect body cascades renders, and
    // the lint rule that catches it is there for exactly this shape.
    const load = lineageId
      ? Promise.all([
          runtime.service.getDerivation(lineageId),
          runtime.service.findUpstreamUpdate(lineageId),
        ])
      : Promise.resolve([undefined, undefined] as const)
    void load
      .then(([nextDerivation, nextUpstream]) => {
        if (!active) return
        setDerivation(nextDerivation)
        setUpstream(nextUpstream)
      })
      .catch(() => {
        if (!active) return
        setDerivation(undefined)
        setUpstream(undefined)
      })
    return () => {
      active = false
    }
  }, [lineageId, originNonce, revision, runtime])

  /**
   * Run an async handler and report what happened.
   *
   * Seven handlers here were `void fn()` with no catch, and every one of them
   * can throw: `publish` on a revision clash or a bump mismatch,
   * `exportPackage` on a release the repository does not hold (a plugin- or
   * overlay-supplied one always), `instantiate` on any adapter failure,
   * `importPackage` on a signature or bounds violation. All of them surfaced
   * as an unhandled rejection and a UI where nothing happened.
   */
  const guard = useCallback(
    (fn: () => Promise<void>) => () => {
      void fn().catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : String(error))
      })
    },
    []
  )

  /**
   * Released versions per definition, so an instance card can offer the ones it
   * could move to. Derived from the catalog the page already reads rather than
   * a per-card query.
   */
  const releasedVersionsByDefinition = useMemo(() => {
    const out: Record<string, string[]> = {}
    for (const definition of definitions) {
      if (!definition.version) continue
      if (definition.status === "yanked" || definition.status === "tombstone") continue
      ;(out[definition.id] ??= []).push(definition.version)
    }
    return out
  }, [definitions])

  const openUpdate = async (instanceId: string, version: string) => {
    setUpdatePlan(await runtime.service.planUpdate(instanceId, version))
  }

  const applyUpdate = async (
    target: TemplateUpdatePlan,
    resolutions: Record<string, TemplateConflictResolution>
  ) => {
    await runtime.service.applyUpdate(target, { confirmed: true, resolutions })
    setUpdatePlan(undefined)
    setMessage(t("messages.updated", { version: target.next.version ?? "" }))
    setInstances(await runtime.repository.listInstances(instanceScope))
  }

  const detachInstance = async (instanceId: string) => {
    await runtime.service.detachInstance(instanceId)
    setMessage(t("messages.detached"))
    setInstances(await runtime.repository.listInstances(instanceScope))
  }

  /**
   * Fork a published release into a new editable draft. `service.fork` existed
   * with no caller, which is why the only way to base a template on an existing
   * one was to create a blank draft and retype it.
   */
  const forkSelected = async () => {
    if (!selected) return
    const forked = await runtime.service.fork(selected.id, {
      ...(selected.version ? { version: selected.version } : {}),
      newId: makeTemplateDraftId(selected.domain, `${selected.metadata.name} copy`),
    })
    route.setDefinitionId(forked.id)
    setPinnedEnvelope(undefined)
    // Ownership can have changed, and global search reads a snapshot of it.
    await refreshTemplateOwners()
    setMessage(t("messages.forked", { id: forked.id }))
  }

  /**
   * Reconcile a fork with a newer release of what it came from.
   *
   * The lineage and the upstream lookup both come from the service, so the
   * inspector never has to guess which release a fork is measured against.
   */
  const reviewDerivedUpdate = async () => {
    if (!selected) return
    setDerivedPlan(await runtime.service.planDerivedUpdate(selected.id))
  }

  const applyDerivedUpdate = async (
    target: TemplateDerivedUpdatePlan,
    resolutions: Record<string, TemplateConflictResolution>
  ) => {
    await runtime.service.applyDerivedUpdate(target, { confirmed: true, resolutions })
    setDerivedPlan(undefined)
    setOriginNonce((value) => value + 1)
    setMessage(t("origin.merged"))
  }

  const detachDerivation = async () => {
    if (!selected) return
    await runtime.service.detachDerivation(selected.id)
    setOriginNonce((value) => value + 1)
    setMessage(t("origin.detached"))
  }

  /**
   * Confine the selected definition to this workspace, or share it again.
   *
   * `service.setDefinitionWorkspace` shipped with no production caller, so the
   * only moment a template could be confined was the instant it was forked, and
   * nothing could ever undo that. Ownership is a local-row field, so this
   * changes who LISTS the definition and touches neither the envelope nor its
   * content hash.
   */
  const setDefinitionWorkspace = async (workspaceId: string | null) => {
    if (!selected) return
    await runtime.service.setDefinitionWorkspace(selected.id, workspaceId)
    // Global search ranks on a synchronous snapshot of ownership, so it has to
    // be retaken here for the same reason `forkSelected` retakes it.
    await refreshTemplateOwners()
    setMessage(t(workspaceId ? "messages.confined" : "messages.shared"))
  }

  /** Withdraw a release. `deprecate` also had no caller. */
  const deprecateSelected = async (status: "deprecated" | "yanked") => {
    if (!selected?.version) return
    await runtime.service.deprecate(selected.id, selected.version, status)
    setMessage(t(`messages.${status}`))
  }

  const selectDefinition = (definition: TemplateDefinitionEnvelope) => {
    selectEnvelope(definition)
    setBindings({})
    setPlan(undefined)
    setInspectorOpen(true)
  }

  const createDraft = async () => {
    const trimmed = draftName.trim()
    if (!trimmed) return
    const id = makeTemplateDraftId(draftDomain, trimmed)
    await runtime.service.createDraft({
      id,
      domain: draftDomain,
      metadata: { name: trimmed, description: draftDescription.trim() || undefined },
      payload: defaultPayload(draftDomain, trimmed, t("defaults.teamLead")),
      inputs: [],
      dependencies: [],
      capabilities: [],
      compatibility: { platforms: ["desktop", "web", "mobile"] },
    })
    setDraftName("")
    setDraftDescription("")
    setCreateOpen(false)
    setMessage(t("messages.draftCreated"))
  }

  const runPreflight = async () => {
    if (!selected) return
    const next = await runtime.service.preflight({
      definitionId: selected.id,
      ...(selected.version ? { version: selected.version } : {}),
      platform: templatePlatform,
      bindings,
    })
    setPlan(next)
  }

  /**
   * `plan.requiresConfirmation` is set whenever a binding resolves a secret or
   * a twin slot, and the preflight alert already says so. The button passed
   * `confirmed: true` unconditionally, so the one gate the plan asks for was
   * answered by the caller on the user's behalf.
   */
  const instantiate = async () => {
    if (!plan) return
    if (plan.status === "needs-confirmation") {
      setPendingInstantiate(plan)
      return
    }
    await commitInstantiate(plan)
  }

  const commitInstantiate = async (target: TemplatePreflightPlan) => {
    await runtime.service.instantiate({ plan: target, confirmed: true })
    setPendingInstantiate(undefined)
    setMessage(t("messages.instantiated"))
    setPlan(undefined)
    setInstances(await runtime.repository.listInstances(instanceScope))
  }

  /**
   * Ask for the version, then publish.
   *
   * `service.publish` refuses a `confirmedBump` that does not match its own
   * conservative suggestion, and returns the reasons, precisely so a human sees
   * why a change is major before it becomes major. Fetching the suggestion and
   * handing it straight back satisfied the check and defeated the point.
   */
  const openPublish = async () => {
    if (!selected || selected.status !== "draft") return
    const suggestion = await runtime.service.getPublishSuggestion(selected.id)
    setPublishSuggestion({ ...suggestion, bump: suggestion.bump as TemplateVersionBump })
  }

  const publish = async (bump: TemplateVersionBump) => {
    if (!selected || selected.status !== "draft") return
    const published = await runtime.service.publish(selected.id, {
      expectedRevision: selected.revision,
      confirmedBump: bump,
    })
    setPublishSuggestion(null)
    selectEnvelope(published)
    setMessage(t("messages.published", { version: published.version }))
  }

  /**
   * Persist an edit to the selected draft.
   *
   * `service.saveDraft` had no caller anywhere in the app. The Studio could
   * mint a stub payload (`defaultPayload`) and publish it, but never change
   * what was in it — and the advertised escape hatch, the per-domain "open
   * editor" link, points two of its six domains at `?mode=template-authoring`,
   * a parameter nothing in the repository handles. Templates were write-once
   * from the moment they were created.
   *
   * Errors propagate to the editor, which renders them: `saveDraft` refuses a
   * payload that fails validation and names the reasons, and swallowing that
   * here would leave the user staring at an unchanged box.
   */
  const saveDraft = async (edits: {
    name: string
    description: string
    payload: TemplateJson
    inputs: TemplateInputSpec[]
    metadata: TemplateMetadataDraft
  }) => {
    if (!selected) return
    const saved = await runtime.service.saveDraft(
      {
        ...selected,
        metadata: {
          ...selected.metadata,
          ...edits.metadata.metadata,
          name: edits.name,
          description: edits.description || undefined,
        },
        payload: edits.payload,
        inputs: edits.inputs,
        dependencies: edits.metadata.dependencies,
        capabilities: edits.metadata.capabilities,
        compatibility: edits.metadata.compatibility,
      },
      selected.revision
    )
    // Follows the row that was actually written, id included: a revision clash
    // forks the edit into a conflict draft under a NEW id, so keeping the old
    // `?definition=` would leave the inspector on the row the user did not
    // change.
    selectEnvelope(saved)
    // A revision clash does not fail — `saveDraft` forks the edit into its own
    // conflict draft under a new id. Say so, rather than reporting a plain
    // success against a row the user is no longer looking at.
    setMessage(
      saved.id === selected.id
        ? t("messages.draftSaved")
        : t("messages.draftForked", { id: saved.id })
    )
  }

  /** Every published release, so the export dialog can bundle more than one. */
  const releases = useMemo(
    () => definitions.filter((definition) => Boolean(definition.version)),
    [definitions]
  )

  /** The same list, shaped for an instance card's rebind picker. */
  const rebindTargets = useMemo(
    () =>
      releases.map((definition) => ({
        id: definition.id,
        version: definition.version!,
        name: definition.metadata.name,
        domain: definition.domain as string,
      })),
    [releases]
  )

  const runExport = async (request: TemplateExportRequest) => {
    const exported = await runtime.service.exportPackage(request)
    setExportOrigin(undefined)
    downloadPackage(exported.bytes, `${request.id}-${request.version}.cognia-template`)
  }

  const verifyPackage = async (key: string) => {
    const report = await runtime.service.verifyPackage(key)
    setPackageReports((prev) => ({ ...prev, [key]: report }))
    setPackages(await runtime.repository.listPackages())
  }

  const yankPackage = async (key: string, yanked: boolean) => {
    await runtime.service.yankPackage(key, yanked)
    setMessage(t(yanked ? "messages.packageYanked" : "messages.packageUnyanked"))
    setPackages(await runtime.repository.listPackages())
  }

  const removePackage = async (key: string) => {
    const removed = await runtime.service.removePackage(key)
    setMessage(t("messages.packageRemoved", removed))
    setPackageReports((prev) => {
      const next = { ...prev }
      delete next[key]
      return next
    })
    setPackages(await runtime.repository.listPackages())
    setInstances(await runtime.repository.listInstances(instanceScope))
  }

  const reexportPackage = async (key: string) => {
    const exported = await runtime.service.reexportPackage(key)
    downloadPackage(
      exported.bytes,
      `${exported.manifest.id}-${exported.manifest.version}.cognia-template`
    )
  }

  const rollbackMigration = async (domain: TemplateDomain) => {
    const rolledBack = await runtime.service.rollbackMigration(domain)
    setMessage(t("messages.migrationRolledBack", { count: rolledBack }))
  }

  /**
   * Discard a draft. Only drafts: a release is immutable by construction and
   * `deprecate` is how one is withdrawn.
   */
  const deleteSelectedDraft = async () => {
    if (!selected || (selected.status !== "draft" && selected.status !== "conflict")) return
    await runtime.service.deleteDraft(selected.id)
    route.setDefinitionId(undefined)
    setPinnedEnvelope(undefined)
    setPlan(undefined)
    setMessage(t("messages.draftDeleted"))
  }

  const rebindInstance = async (instanceId: string, definitionId: string, version: string) => {
    await runtime.service.rebindSource(instanceId, definitionId, version)
    setMessage(t("messages.rebound"))
    setInstances(await runtime.repository.listInstances(instanceScope))
  }

  const inspectImport = async (file?: File) => {
    if (!file) return
    const bytes = new Uint8Array(await file.arrayBuffer())
    setPendingImport({ bytes, inspected: await runtime.service.inspectPackage(bytes) })
    if (importRef.current) importRef.current.value = ""
  }

  const confirmImport = async () => {
    if (!pendingImport) return
    await runtime.service.importPackage(pendingImport.bytes, {
      source: "file",
      confirmed: true,
    })
    setPendingImport(undefined)
    setMessage(t("messages.imported"))
  }

  const header = (
    <FeaturePageHeader
      icon={<FileArchiveIcon />}
      title={t("title")}
      description={t("description")}
      variant="card"
      actions={
        platform === "mobile" ? null : (
          <div className="flex items-center gap-2">
            <input
              ref={importRef}
              type="file"
              accept=".cognia-template,application/zip"
              className="hidden"
              onChange={(event) => guard(() => inspectImport(event.target.files?.[0]))()}
            />
            <Button variant="outline" onClick={() => importRef.current?.click()}>
              <UploadIcon className="size-4" />
              {t("actions.import")}
            </Button>
            <Button onClick={() => setCreateOpen(true)}>
              <PlusIcon className="size-4" />
              {t("actions.newDraft")}
            </Button>
          </div>
        )
      }
    />
  )

  /**
   * The inspector is the shell's right rail rather than a 360px column inside
   * every tab. It was declared three times, once per definition tab, and the
   * page owned no `data-bg-target` at all, so an enabled wallpaper simply did
   * not reach /templates. `FeaturePageShell` owns both, plus panel-size
   * persistence and the below-`md` Sheet fallback, which is why twelve other
   * feature routes are already on it.
   */
  const inspector = (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <TemplateInspector
        definition={selected}
        bindings={bindings}
        setBindings={setBindings}
        plan={plan}
        mobile={platform === "mobile"}
        tier={selected ? tierOf(selected) : undefined}
        {...(selected && owners[selected.id] !== undefined
          ? { ownerWorkspaceId: owners[selected.id] }
          : {})}
        activeWorkspaceId={activeWorkspaceId}
        onSetWorkspace={(workspaceId) => guard(() => setDefinitionWorkspace(workspaceId))()}
        onPreflight={guard(runPreflight)}
        onInstantiate={guard(instantiate)}
        onPublish={guard(openPublish)}
        onSaveDraft={saveDraft}
        onExport={() => setExportOrigin(selected)}
        onFork={guard(forkSelected)}
        derivation={derivation}
        upstream={upstream}
        onReviewUpdate={guard(reviewDerivedUpdate)}
        onDetach={guard(detachDerivation)}
        onDeprecate={guard(() => deprecateSelected("deprecated"))}
        onYank={guard(() => deprecateSelected("yanked"))}
        onDeleteDraft={guard(deleteSelectedDraft)}
        t={t}
      />
    </div>
  )

  return (
    <>
      <FeaturePageShell
        storageId="templates"
        header={header}
        centerClassName="gap-4 p-4"
        rightPane={{
          label: t("inspector.label"),
          content: inspector,
          defaultSize: 28,
          minSize: 20,
          maxSize: 44,
          // Controlled, because the centre pane is what selects the row the
          // rail shows. Left uncontrolled, a tap on a phone-width viewport set
          // the selection in a Sheet nobody had opened, so the card read as a
          // dead end.
          open: inspectorOpen,
          onOpenChange: setInspectorOpen,
        }}
      >
        <div className="flex min-h-0 flex-1 flex-col gap-4" data-testid="template-studio">
          {platform === "mobile" ? (
            <Alert>
              <ExternalLinkIcon />
              <AlertTitle>{t("mobile.title")}</AlertTitle>
              <AlertDescription>{t("mobile.description")}</AlertDescription>
            </Alert>
          ) : null}
          {message ? (
            <Alert>
              <CheckCircle2Icon />
              <AlertDescription>{message}</AlertDescription>
            </Alert>
          ) : null}

          {/* Controlled by `?tab=`. `useTemplateRouteState` has owned `tab` and
              `setTab` since the phone body landed and nothing read them: the
              Studio was `defaultValue="library"`, so `/templates?tab=instances`
              opened the Library and the tab a user was on could not be sent to
              anyone. `FeaturePageShell` also renders its children through two
              different trees and REMOUNTS the subtree at the breakpoint, which
              is the second reason this cannot be component state. */}
          <Tabs
            value={route.tab}
            onValueChange={(value) => {
              if ((TEMPLATE_TABS as readonly string[]).includes(value)) {
                route.setTab(value as TemplateTab)
              }
            }}
            className="min-h-0 flex-1"
          >
            <TabsList className="flex w-full justify-start overflow-x-auto">
              {/* Rendered from the contract rather than hand-listed, so a tab
                  added to `TEMPLATE_TABS` cannot ship without a trigger. */}
              {TEMPLATE_TABS.map((tab) => (
                <TabsTrigger key={tab} value={tab}>
                  {t(`tabs.${tab}`)}
                </TabsTrigger>
              ))}
            </TabsList>
            {(["library", "drafts", "published"] as const).map((tab) => {
              const rows = definitions.filter((definition) => {
                if (tab === "drafts")
                  return definition.status === "draft" || definition.status === "conflict"
                if (tab === "published") return definition.version !== null
                return true
              })
              return (
                <TabsContent key={tab} value={tab} className="min-h-0">
                  <div className="mb-3 grid gap-2 md:grid-cols-[1fr_180px_180px]">
                    <div className="relative">
                      <SearchIcon className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
                      <Input
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder={t("filters.search")}
                        className="pl-9"
                      />
                    </div>
                    <Select
                      value={domain}
                      onValueChange={(value) => setDomain(value as typeof domain)}
                    >
                      <SelectTrigger aria-label={t("filters.domain")}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">{t("filters.allDomains")}</SelectItem>
                        {FILTERABLE_DOMAINS.map((item) => (
                          <SelectItem
                            key={item}
                            value={item}
                            disabled={INERT_DOMAINS.has(item)}
                            data-testid={`template-domain-${item}`}
                          >
                            {INERT_DOMAINS.has(item)
                              ? t("filters.domainInert", { domain: t(`domains.${item}`) })
                              : t(`domains.${item}`)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select value={tier} onValueChange={(value) => setTier(value as typeof tier)}>
                      <SelectTrigger aria-label={t("filters.scope")}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">{t("filters.allScopes")}</SelectItem>
                        {TEMPLATE_SCOPE_TIERS.map((item) => (
                          <SelectItem key={item} value={item}>
                            {t(`scopes.${item}`)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select
                      value={trust}
                      onValueChange={(value) => setTrust(value as typeof trust)}
                    >
                      <SelectTrigger aria-label={t("filters.trust")}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">{t("filters.allTrust")}</SelectItem>
                        {(
                          ["built-in", "verified-publisher", "signed-unknown", "unsigned"] as const
                        ).map((item) => (
                          <SelectItem key={item} value={item}>
                            {t(`trust.${item}`)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid content-start gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    {rows.map((definition) => (
                      <Card
                        key={`${definition.id}@${definition.version ?? definition.revision}`}
                        role="button"
                        tabIndex={0}
                        // Selection was conveyed by a border alone, and Space did
                        // nothing: a `role="button"` that only answers Enter is
                        // half a button to anyone not using a mouse.
                        aria-pressed={selected?.contentHash === definition.contentHash}
                        className={
                          selected?.contentHash === definition.contentHash ? "border-primary" : ""
                        }
                        onClick={() => selectDefinition(definition)}
                        onKeyDown={(event) => {
                          if (event.key !== "Enter" && event.key !== " ") return
                          event.preventDefault()
                          selectDefinition(definition)
                        }}
                      >
                        <CardHeader className="pb-2">
                          <div className="flex items-start justify-between gap-2">
                            <CardTitle className="text-base">{definition.metadata.name}</CardTitle>
                            <Badge variant="outline">{t(`domains.${definition.domain}`)}</Badge>
                          </div>
                        </CardHeader>
                        <CardContent className="space-y-2 text-sm">
                          <p className="line-clamp-2 text-muted-foreground">
                            {definition.metadata.description || t("empty.noDescription")}
                          </p>
                          <div className="flex flex-wrap gap-1">
                            {/* Which shelf this came from. Ownership beats
                                provenance, so a built-in you forked into one
                                workspace reads as that workspace's. */}
                            <Badge variant="outline" data-testid="template-card-scope">
                              {t(`scopes.${tierOf(definition)}`)}
                            </Badge>
                            <Badge variant="secondary">{t(`status.${definition.status}`)}</Badge>
                            <Badge variant="secondary">
                              {t(`trust.${definition.provenance.trust}`)}
                            </Badge>
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                    {rows.length === 0 ? (
                      <p className="text-sm text-muted-foreground">{t("empty.noResults")}</p>
                    ) : null}
                    {/* Say what the workspace is holding back. A library that
                        quietly omits rows reads as one that lost them. */}
                    {hiddenCount > 0 ? (
                      <p
                        className="text-xs text-muted-foreground"
                        data-testid="template-hidden-count"
                      >
                        {t("filters.hiddenHere", { count: hiddenCount })}
                      </p>
                    ) : null}
                  </div>
                </TabsContent>
              )
            })}
            <TabsContent value="packages" className="min-h-0 overflow-y-auto">
              <TemplatePackagesTab
                packages={packages}
                reports={packageReports}
                onVerify={(key) => guard(() => verifyPackage(key))()}
                onYank={(key, yanked) => guard(() => yankPackage(key, yanked))()}
                onRemove={(key) => guard(() => removePackage(key))()}
                onReexport={(key) => guard(() => reexportPackage(key))()}
                onRollbackMigration={(domain) => guard(() => rollbackMigration(domain))()}
              />
            </TabsContent>
            <TabsContent value="instances" className="space-y-3">
              {/* An instance records that a template was used in a particular
                  workspace, so the default view is this one. The toggle exists
                  because "where did I instantiate that" is a real question, and
                  answering it by silently omitting rows is not. */}
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-muted-foreground">
                  {allWorkspaceInstances
                    ? t("instances.scopeAll", { count: instances.length })
                    : t("instances.scopeCurrent", { count: instances.length })}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setAllWorkspaceInstances((value) => !value)}
                  data-testid="template-instances-scope"
                >
                  {allWorkspaceInstances ? t("instances.showCurrent") : t("instances.showAll")}
                </Button>
              </div>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {instances.map((instance) => (
                  <TemplateInstanceCard
                    key={instance.id}
                    instance={instance}
                    availableVersions={
                      releasedVersionsByDefinition[instance.source.definitionId] ?? []
                    }
                    rebindTargets={rebindTargets}
                    onPlanUpdate={(id, version) => guard(() => openUpdate(id, version))()}
                    onDetach={(id) => guard(() => detachInstance(id))()}
                    onRebind={(id, definitionId, version) =>
                      guard(() => rebindInstance(id, definitionId, version))()
                    }
                  />
                ))}
              </div>
            </TabsContent>
          </Tabs>
        </div>
      </FeaturePageShell>

      <PublishConfirmDialog
        suggestion={publishSuggestion}
        onOpenChange={(open) => (open ? undefined : setPublishSuggestion(null))}
        onConfirm={(bump) => guard(() => publish(bump))()}
      />
      <TemplateDerivedUpdateDialog
        plan={derivedPlan}
        onOpenChange={(open) => !open && setDerivedPlan(undefined)}
        onConfirm={(target, resolutions) => guard(() => applyDerivedUpdate(target, resolutions))()}
      />
      <TemplateUpdateDialog
        plan={updatePlan}
        onOpenChange={(open) => (open ? undefined : setUpdatePlan(undefined))}
        onConfirm={(target, resolutions) => guard(() => applyUpdate(target, resolutions))()}
      />
      <TemplateExportDialog
        origin={exportOrigin}
        releases={releases}
        onOpenChange={(open) => (open ? undefined : setExportOrigin(undefined))}
        onExport={(request) => guard(() => runExport(request))()}
      />
      <InstantiateConfirmDialog
        plan={pendingInstantiate}
        onOpenChange={(open) => (open ? undefined : setPendingInstantiate(undefined))}
        onConfirm={(target) => guard(() => commitInstantiate(target))()}
      />
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("create.title")}</DialogTitle>
            <DialogDescription>{t("create.description")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="template-domain">{t("create.domain")}</Label>
              <Select
                value={draftDomain}
                onValueChange={(value) => setDraftDomain(value as TemplateDomain)}
              >
                <SelectTrigger id="template-domain">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FULL_DOMAINS.map((item) => (
                    <SelectItem key={item} value={item}>
                      {t(`domains.${item}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="template-name">{t("create.name")}</Label>
              <Input
                id="template-name"
                value={draftName}
                onChange={(event) => setDraftName(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="template-description">{t("create.templateDescription")}</Label>
              <Textarea
                id="template-description"
                value={draftDescription}
                onChange={(event) => setDraftDescription(event.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              {t("actions.cancel")}
            </Button>
            <Button onClick={guard(createDraft)} disabled={!draftName.trim()}>
              {t("actions.create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(pendingImport)}
        onOpenChange={(open) => !open && setPendingImport(undefined)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("import.title")}</DialogTitle>
            <DialogDescription>{t("import.description")}</DialogDescription>
          </DialogHeader>
          {pendingImport ? (
            <div className="space-y-3 text-sm">
              {/* The alarm state was unconditional, so a correctly signed
                  package from a verified publisher looked exactly as dangerous
                  as an unsigned one, and the four trust levels stopped meaning
                  anything. Only the two the app cannot vouch for are alarming. */}
              <Alert
                variant={
                  pendingImport.inspected.trust === "unsigned" ||
                  pendingImport.inspected.trust === "signed-unknown"
                    ? "destructive"
                    : "default"
                }
                data-testid="template-import-trust"
                data-trust={pendingImport.inspected.trust}
              >
                {pendingImport.inspected.trust === "unsigned" ||
                pendingImport.inspected.trust === "signed-unknown" ? (
                  <AlertTriangleIcon />
                ) : (
                  <CheckCircle2Icon />
                )}
                <AlertTitle>{t(`trust.${pendingImport.inspected.trust}`)}</AlertTitle>
                <AlertDescription>{t("import.inert")}</AlertDescription>
              </Alert>
              <p>{pendingImport.inspected.manifest.name}</p>
              <p>
                {t("import.definitionCount", { count: pendingImport.inspected.definitions.length })}
              </p>
              <p className="break-all font-mono text-xs">{pendingImport.inspected.fingerprint}</p>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingImport(undefined)}>
              {t("actions.cancel")}
            </Button>
            <Button onClick={guard(confirmImport)}>{t("actions.confirmImport")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function TemplateInspector({
  definition,
  bindings,
  setBindings,
  plan,
  mobile,
  tier,
  ownerWorkspaceId,
  activeWorkspaceId,
  onSetWorkspace,
  onPreflight,
  onInstantiate,
  onPublish,
  onSaveDraft,
  onExport,
  onFork,
  derivation,
  upstream,
  onReviewUpdate,
  onDetach,
  onDeprecate,
  onYank,
  onDeleteDraft,
  t,
}: {
  definition?: TemplateDefinitionEnvelope
  bindings: Record<string, string>
  setBindings(value: Record<string, string>): void
  plan?: TemplatePreflightPlan
  mobile: boolean
  /** The selected definition's shelf, for the ownership control. */
  tier?: TemplateScopeTier
  /** The workspace that owns it today, absent when it is shared. */
  ownerWorkspaceId?: string
  activeWorkspaceId?: string | null
  onSetWorkspace(workspaceId: string | null): void
  onPreflight(): void
  onInstantiate(): void
  onPublish(): void
  onSaveDraft(edits: {
    name: string
    description: string
    payload: TemplateJson
    inputs: TemplateInputSpec[]
    metadata: TemplateMetadataDraft
  }): Promise<void>
  onExport(): void
  onFork(): void
  derivation?: TemplateDerivation
  upstream?: TemplateDefinitionEnvelope
  onReviewUpdate(): void
  onDetach(): void
  onDeprecate(): void
  onYank(): void
  onDeleteDraft(): void
  t: ReturnType<typeof useTranslations<"templateStudio">>
}) {
  if (!definition) {
    return (
      <Card>
        <CardContent className="pt-6 text-sm text-muted-foreground">
          {t("inspector.empty")}
        </CardContent>
      </Card>
    )
  }
  const catalogOnly = !FULL_DOMAINS.includes(definition.domain)
  /**
   * A node group is `domain: "workflow"` but its payload is a subgraph, not a
   * workflow: no `name`, no `nodes` at the top level the workflow adapter
   * expects. Instantiating one routed that payload into `createWorkflow`, which
   * reads `draft.name.trim()` and threw on `undefined`. Its inputs are also
   * auto-derived graph ports (`input:nodeA:default`), all `required`, so
   * preflight blocked until the user typed values for them. It belongs in the
   * workflow editor's own templates tab, and here it reads only.
   */
  const nodeGroup = isWorkflowNodeGroupDefinition(definition)
  const readOnly = catalogOnly || nodeGroup
  // A published release is immutable by construction (`DexieTemplateRepository`
  // refuses to overwrite one), and a catalog-only row is a projection of a
  // store this platform does not own. That leaves drafts — including the
  // conflict drafts a clashing save produces, which are otherwise unreachable.
  const editable =
    !mobile && !readOnly && (definition.status === "draft" || definition.status === "conflict")
  return (
    <Card className="h-fit">
      <CardHeader>
        <CardTitle>{definition.metadata.name}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="space-y-1">
          <p>{definition.metadata.description || t("empty.noDescription")}</p>
          <p className="font-mono text-xs text-muted-foreground">
            {definition.id}
            {definition.version ? `@${definition.version}` : ""}
          </p>
          <p>{t("inspector.source", { source: definition.provenance.source })}</p>
          <p>{t("inspector.hash", { hash: definition.contentHash })}</p>
        </div>
        <TemplateOriginCard
          derivation={derivation}
          upstream={upstream}
          onReviewUpdate={onReviewUpdate}
          onDetach={onDetach}
          readOnly={mobile || readOnly}
        />
        {/* Ownership, which is a different question from the fork lineage above
            it: where this definition is LISTED, not where it came from.
            Authoring is desktop-only, and so is this. */}
        {!mobile && tier ? (
          <TemplateScopeControl
            tier={tier}
            {...(ownerWorkspaceId !== undefined ? { ownerWorkspaceId } : {})}
            activeWorkspaceId={activeWorkspaceId}
            onChange={onSetWorkspace}
          />
        ) : null}
        {definition.inputs.map((input) => (
          <TemplateBindingField
            key={input.id}
            input={input}
            value={bindings[input.id] ?? ""}
            onChange={(next) => setBindings({ ...bindings, [input.id]: next })}
          />
        ))}
        {plan ? (
          <Alert variant={plan.status === "blocked" ? "destructive" : "default"}>
            {plan.status === "blocked" ? <AlertTriangleIcon /> : <CheckCircle2Icon />}
            <AlertTitle>{t(`preflight.${plan.status}`)}</AlertTitle>
            <AlertDescription>
              <ul className="list-disc space-y-1 pl-4">
                {plan.issues.map((issue) => (
                  <li key={`${issue.code}:${issue.path ?? ""}`}>{t(`issues.${issue.code}`)}</li>
                ))}
                {plan.operations.map((operation) => (
                  <li key={operation.id}>{t(`operations.${operation.kind}`)}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {readOnly ? (
            <Badge variant="outline" data-testid="template-read-only">
              {nodeGroup ? t("inspector.nodeGroup") : t("inspector.readOnly")}
            </Badge>
          ) : (
            <Button variant="outline" onClick={onPreflight}>
              {t("actions.preflight")}
            </Button>
          )}
          {plan && plan.status !== "blocked" ? (
            <Button onClick={onInstantiate}>{t("actions.instantiate")}</Button>
          ) : null}
          {!mobile && definition.status === "draft" ? (
            <Button variant="secondary" onClick={onPublish}>
              {t("actions.publish")}
            </Button>
          ) : null}
          {!mobile && definition.version ? (
            <Button variant="outline" onClick={onExport}>
              <DownloadIcon className="size-4" />
              {t("actions.export")}
            </Button>
          ) : null}
          {/* `fork` and `deprecate` shipped with no caller anywhere in the app,
              so the only way to base a template on an existing one was to
              create a blank draft and retype it, and a published release could
              never be withdrawn. */}
          {!mobile && !readOnly ? (
            <Button variant="outline" onClick={onFork} data-testid="template-fork">
              <GitForkIcon className="size-4" />
              {t("actions.fork")}
            </Button>
          ) : null}
          {!mobile && definition.version && definition.status === "published" ? (
            <>
              <Button
                variant="ghost"
                className="text-destructive"
                onClick={onDeprecate}
                data-testid="template-deprecate"
              >
                {t("actions.deprecate")}
              </Button>
              {/* Deprecate and yank are the two halves of `setReleaseStatus`,
                  and only the first had a caller: a release that should never
                  be installed again could only be marked superseded. */}
              <Button
                variant="ghost"
                className="text-destructive"
                onClick={onYank}
                data-testid="template-yank"
              >
                {t("actions.yank")}
              </Button>
            </>
          ) : null}
          {/* `repository.deleteDraft` was reachable only from the migration
              rollback path, so a draft made by mistake, or the conflict draft a
              clashing save forks off, could be edited forever but never removed. */}
          {!mobile && (definition.status === "draft" || definition.status === "conflict") ? (
            <Button
              variant="ghost"
              className="text-destructive"
              onClick={onDeleteDraft}
              data-testid="template-delete-draft"
            >
              <Trash2Icon className="size-4" />
              {t("actions.deleteDraft")}
            </Button>
          ) : null}
          {!mobile && EDITOR_ROUTES[definition.domain] ? (
            <Button asChild variant="ghost">
              <Link href={EDITOR_ROUTES[definition.domain]}>
                {t("actions.openEditor")}
                <ExternalLinkIcon className="size-4" />
              </Link>
            </Button>
          ) : null}
        </div>
        <Collapsible className="group/collapsible">
          <CollapsibleTrigger asChild>
            <Button variant="ghost" className="h-auto w-full justify-between px-0 py-1">
              {editable ? t("draftEditor.title") : t("inspector.payload")}
              <ChevronDownIcon className="size-4 transition-transform group-data-[state=open]/collapsible:rotate-180" />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            {editable ? (
              // Keyed on the content hash so selecting another row — or a save
              // landing a new revision — re-seeds the fields instead of leaving
              // the previous draft's text in the box.
              <TemplateDraftEditor
                key={definition.contentHash}
                definition={definition}
                onSave={onSaveDraft}
                t={t}
              />
            ) : (
              <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-muted p-3 text-xs">
                {JSON.stringify(definition.payload, null, 2)}
              </pre>
            )}
          </CollapsibleContent>
        </Collapsible>
      </CardContent>
    </Card>
  )
}

/**
 * Edit a draft's name, description and payload in place.
 *
 * The payload is edited as JSON rather than through a per-domain form: the six
 * full domains each already own a purpose-built editor, and this is the seam
 * that makes a draft mutable at all. Parse failures and the validation errors
 * `saveDraft` raises are rendered here rather than thrown away — a save that
 * silently does nothing is the failure mode this whole component exists to
 * remove.
 */
function TemplateDraftEditor({
  definition,
  onSave,
  t,
}: {
  definition: TemplateDefinitionEnvelope
  onSave(edits: {
    name: string
    description: string
    payload: TemplateJson
    inputs: TemplateInputSpec[]
    metadata: TemplateMetadataDraft
  }): Promise<void>
  t: ReturnType<typeof useTranslations<"templateStudio">>
}) {
  const [name, setName] = useState(definition.metadata.name)
  const [description, setDescription] = useState(definition.metadata.description ?? "")
  const [payloadText, setPayloadText] = useState(() => JSON.stringify(definition.payload, null, 2))
  const [inputs, setInputs] = useState<TemplateInputSpec[]>(() =>
    structuredClone(definition.inputs)
  )
  const [metadata, setMetadata] = useState<TemplateMetadataDraft>(() => {
    const { name: _name, description: _description, ...rest } = definition.metadata
    return {
      metadata: structuredClone(rest),
      dependencies: structuredClone(definition.dependencies),
      capabilities: [...definition.capabilities],
      compatibility: structuredClone(definition.compatibility),
    }
  })
  const [error, setError] = useState<string>()
  const [saving, setSaving] = useState(false)

  /**
   * The tokens the payload actually uses, split by whether anything declares
   * them — recomputed from the TEXT on every keystroke, so the answer tracks
   * what the user is typing rather than the last thing they saved.
   *
   * Null while the JSON is unparseable: mid-edit is not a moment to complain
   * about missing declarations. `listTemplateTokens` is the same classifier
   * `interpolation.unknown` uses on save, so this list cannot disagree with the
   * error the save would produce — including the workflow domain, where a
   * `{{ $node['a'].output }}` expression belongs to the workflow engine and is
   * not an authoring gap at all.
   */
  const tokens = useMemo(() => {
    let payload: TemplateJson
    try {
      payload = JSON.parse(payloadText) as TemplateJson
    } catch {
      return null
    }
    return listTemplateTokens(
      payload,
      new Set(inputs.map((input) => input.id)),
      definition.domain === "workflow"
    )
  }, [payloadText, inputs, definition.domain])

  // Tokens that could become an input, and tokens that could not. Offering to
  // declare something that would then fail the `input.id` check is worse than
  // not offering, so the two are separated and only the first gets a button.
  const declarable = (tokens?.unknown ?? []).filter(isTemplateInputId)
  const undeclarable = (tokens?.unknown ?? []).filter((token) => !isTemplateInputId(token))

  const patchInput = (index: number, patch: Partial<TemplateInputSpec>) =>
    setInputs((prev) =>
      prev.map((input, i) => (i === index ? ({ ...input, ...patch } as TemplateInputSpec) : input))
    )

  const save = async () => {
    const trimmed = name.trim()
    if (!trimmed) {
      setError(t("draftEditor.nameRequired"))
      return
    }
    let payload: TemplateJson
    try {
      payload = JSON.parse(payloadText) as TemplateJson
    } catch {
      setError(t("draftEditor.invalidJson"))
      return
    }
    setError(undefined)
    setSaving(true)
    try {
      await onSave({ name: trimmed, description: description.trim(), payload, inputs, metadata })
    } catch (err) {
      // `saveDraft` refuses an invalid payload and names every reason. Show it
      // verbatim — a generic "save failed" would hide which field is wrong.
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mt-2 space-y-3" data-testid="template-draft-editor">
      <div className="space-y-1.5">
        <Label htmlFor={`draft-name-${definition.id}`}>{t("draftEditor.name")}</Label>
        <Input
          id={`draft-name-${definition.id}`}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`draft-description-${definition.id}`}>{t("draftEditor.description")}</Label>
        <Input
          id={`draft-description-${definition.id}`}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`draft-payload-${definition.id}`}>{t("draftEditor.payload")}</Label>
        <Textarea
          id={`draft-payload-${definition.id}`}
          className="max-h-64 min-h-40 overflow-auto font-mono text-xs"
          value={payloadText}
          onChange={(event) => setPayloadText(event.target.value)}
          spellCheck={false}
        />
      </div>
      <div className="space-y-2 rounded-md border p-3">
        <div className="flex items-center justify-between gap-2">
          <Label>{t("inputs.title")}</Label>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              setInputs((prev) => [...prev, { id: "", label: "", kind: "string", required: true }])
            }
          >
            <PlusIcon className="size-3.5" />
            {t("inputs.add")}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t("inputs.hint")}</p>
        {inputs.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("inputs.none")}</p>
        ) : (
          inputs.map((input, index) => (
            <TemplateInputRow
              key={index}
              input={input}
              t={t}
              onPatch={(patch) => patchInput(index, patch)}
              onRemove={() => setInputs((prev) => prev.filter((_, i) => i !== index))}
            />
          ))
        )}
        {declarable.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-xs text-muted-foreground">
              {t("inputs.undeclared", { ids: declarable.join(", ") })}
            </p>
            <Button
              size="sm"
              variant="secondary"
              onClick={() =>
                setInputs((prev) => [
                  ...prev,
                  ...declarable.map((id): TemplateInputSpec => ({
                    id,
                    // The id is the only thing the payload told us; a label
                    // that repeats it is honest, and it is one field to fix.
                    label: id,
                    // Required by default: a token in the payload with nothing
                    // behind it is what `interpolation.unknown` was refusing.
                    required: true,
                    kind: "string",
                  })),
                ])
              }
            >
              {t("inputs.declareAll")}
            </Button>
          </div>
        ) : null}
        {undeclarable.length > 0 ? (
          <p className="text-xs text-destructive">
            {t("inputs.undeclarableHint", { ids: undeclarable.join(", ") })}
          </p>
        ) : null}
      </div>
      <TemplateMetadataEditor value={metadata} onChange={setMetadata} />
      {error ? (
        <Alert variant="destructive">
          <AlertTriangleIcon />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <Button onClick={() => void save()} disabled={saving}>
        {saving ? t("draftEditor.saving") : t("draftEditor.save")}
      </Button>
    </div>
  )
}

/** Every input kind the contract accepts, in the order the editor offers them. */
const INPUT_KINDS = [
  "string",
  "number",
  "boolean",
  "enum",
  "resource",
  "secretRef",
  "twinSlot",
  "model",
  "provider",
  "tool",
  "skill",
  "character",
  "workflow",
] as const

/** The kinds that carry a free-form resource hint rather than a value. */
const RESOURCE_KINDS = new Set<string>([
  "resource",
  "secretRef",
  "twinSlot",
  "model",
  "provider",
  "tool",
  "skill",
  "character",
  "workflow",
])

/**
 * A default value stored as the type its input declares.
 *
 * Every field in this editor is a text box, so without this a `number` input
 * would carry the string `"3"` — the union permits it and no validator objects,
 * which is exactly how a wrongly-typed value survives all the way to whatever
 * consumes it. Applied on kind change too: switching `string` → `number` must
 * not leave prose sitting in a numeric default.
 */
function coerceInputDefault(
  kind: TemplateInputSpec["kind"],
  raw: string | number | boolean | undefined
): string | number | boolean | undefined {
  if (raw === undefined || raw === "") return undefined
  if (kind === "number") {
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  if (kind === "boolean") return raw === true || raw === "true"
  if (kind === "enum" || RESOURCE_KINDS.has(kind)) return undefined
  return String(raw)
}

function TemplateInputRow({
  input,
  onPatch,
  onRemove,
  t,
}: {
  input: TemplateInputSpec
  onPatch(patch: Partial<TemplateInputSpec>): void
  onRemove(): void
  t: ReturnType<typeof useTranslations<"templateStudio">>
}) {
  const options = input.kind === "enum" ? input.options : []
  const defaultValue = "defaultValue" in input ? input.defaultValue : undefined

  return (
    <div className="space-y-2 rounded-md border p-2" data-testid="template-input-row">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="h-8 w-40 font-mono text-xs"
          aria-label={t("inputs.id")}
          value={input.id}
          onChange={(event) => onPatch({ id: event.target.value })}
        />
        <Input
          className="h-8 min-w-0 flex-1"
          aria-label={t("inputs.label")}
          value={input.label}
          onChange={(event) => onPatch({ label: event.target.value })}
        />
        <Select
          value={input.kind}
          onValueChange={(raw) => {
            const kind = raw as TemplateInputSpec["kind"]
            onPatch({
              kind,
              // An enum with no options is refused by `input.enum-options`, so
              // switching to it seeds one empty choice rather than producing a
              // draft that cannot be saved.
              ...(kind === "enum" ? { options: options.length > 0 ? options : [""] } : {}),
              defaultValue: coerceInputDefault(kind, defaultValue),
            } as Partial<TemplateInputSpec>)
          }}
        >
          <SelectTrigger className="h-8 w-36" aria-label={t("inputs.kind")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {INPUT_KINDS.map((kind) => (
              <SelectItem key={kind} value={kind}>
                {t(`inputKindNames.${kind}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <label className="flex shrink-0 items-center gap-1.5 text-xs">
          <Checkbox
            checked={input.required}
            onCheckedChange={(checked) => onPatch({ required: checked === true })}
          />
          {t("inputs.required")}
        </label>
        <Button variant="ghost" size="icon" aria-label={t("inputs.remove")} onClick={onRemove}>
          <Trash2Icon className="size-4" />
        </Button>
      </div>
      {input.kind === "enum" ? (
        <Textarea
          className="min-h-16 text-xs"
          aria-label={t("inputs.options")}
          value={options.join("\n")}
          onChange={(event) =>
            onPatch({
              options: event.target.value.split("\n").map((line) => line.trim()),
            } as Partial<TemplateInputSpec>)
          }
        />
      ) : RESOURCE_KINDS.has(input.kind) ? (
        <Input
          className="h-8"
          aria-label={t("inputs.resourceKind")}
          placeholder={t("inputs.resourceKind")}
          value={"resourceKind" in input ? (input.resourceKind ?? "") : ""}
          onChange={(event) =>
            onPatch({ resourceKind: event.target.value || undefined } as Partial<TemplateInputSpec>)
          }
        />
      ) : input.kind === "boolean" ? (
        <Select
          value={defaultValue === undefined ? "" : String(defaultValue)}
          onValueChange={(value) =>
            onPatch({ defaultValue: value === "true" } as Partial<TemplateInputSpec>)
          }
        >
          <SelectTrigger className="h-8 w-36" aria-label={t("inputs.default")}>
            <SelectValue placeholder={t("inputs.default")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="true">{t("inputs.booleanTrue")}</SelectItem>
            <SelectItem value="false">{t("inputs.booleanFalse")}</SelectItem>
          </SelectContent>
        </Select>
      ) : (
        <Input
          className="h-8"
          type={input.kind === "number" ? "number" : "text"}
          aria-label={t("inputs.default")}
          placeholder={t("inputs.default")}
          value={defaultValue === undefined ? "" : String(defaultValue)}
          onChange={(event) =>
            onPatch({
              defaultValue: coerceInputDefault(input.kind, event.target.value),
            } as Partial<TemplateInputSpec>)
          }
        />
      )}
    </div>
  )
}
