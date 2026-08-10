"use client"

import { useEffect, useMemo, useRef, useState } from "react"
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
  UploadIcon,
  ChevronDownIcon,
} from "lucide-react"
import { usePlatform } from "@/hooks/use-platform"
import { useTemplateCatalog } from "@/hooks/use-template-catalog"
import type {
  TemplateDefinitionEnvelope,
  TemplateDomain,
  TemplateJson,
  TemplatePlatform,
  TemplateTrust,
  TemplateVersionBump,
} from "@/lib/templates/contracts"
import type { InspectedTemplatePackage } from "@/lib/templates/package"
import type { TemplatePreflightPlan } from "@/lib/templates/service"
import { getTemplateRuntime } from "@/lib/templates/runtime"
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

const FULL_DOMAINS: TemplateDomain[] = [
  "agentTeam",
  "workflow",
  "subagent",
  "customMode",
  "character",
  "skill",
]

const EDITOR_ROUTES: Record<string, string> = {
  agentTeam: "/agent-teams?mode=template-authoring",
  workflow: "/workflows?mode=template-authoring",
  subagent: "/me/subagents",
  customMode: "/settings?section=agent",
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
  anchor.click()
  URL.revokeObjectURL(url)
}

export function TemplateStudio() {
  const t = useTranslations("templateStudio")
  const platform = usePlatform()
  const templatePlatform: TemplatePlatform =
    platform === "mobile" ? "mobile" : platform === "web" ? "web" : "desktop"
  const runtime = useMemo(() => getTemplateRuntime(), [])
  const [query, setQuery] = useState("")
  const [domain, setDomain] = useState<TemplateDomain | "all">("all")
  const [trust, setTrust] = useState<TemplateTrust | "all">("all")
  const { definitions, revision } = useTemplateCatalog({
    text: query,
    platform: templatePlatform,
    ...(domain === "all" ? {} : { domain }),
    ...(trust === "all" ? {} : { trust }),
  })
  const [selectionKey, setSelectionKey] = useState<string | undefined>(() => {
    const requestedId = new URLSearchParams(window.location.search).get("definition")
    return requestedId ? `id:${requestedId}` : undefined
  })
  const selected = useMemo(() => {
    if (!selectionKey) return undefined
    return selectionKey.startsWith("hash:")
      ? definitions.find(
          (definition) => definition.contentHash === selectionKey.slice("hash:".length)
        )
      : definitions.find((definition) => definition.id === selectionKey.slice("id:".length))
  }, [definitions, selectionKey])
  const [packages, setPackages] = useState<
    Awaited<ReturnType<typeof runtime.repository.listPackages>>
  >([])
  const [instances, setInstances] = useState<
    Awaited<ReturnType<typeof runtime.repository.listInstances>>
  >([])
  const [createOpen, setCreateOpen] = useState(false)
  const [draftName, setDraftName] = useState("")
  const [draftDescription, setDraftDescription] = useState("")
  const [draftDomain, setDraftDomain] = useState<TemplateDomain>("skill")
  const [bindings, setBindings] = useState<Record<string, string>>({})
  const [plan, setPlan] = useState<TemplatePreflightPlan>()
  const [message, setMessage] = useState<string>()
  const [pendingImport, setPendingImport] = useState<{
    bytes: Uint8Array
    inspected: InspectedTemplatePackage
  }>()
  const importRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let active = true
    void Promise.all([runtime.repository.listPackages(), runtime.repository.listInstances()]).then(
      ([nextPackages, nextInstances]) => {
        if (!active) return
        setPackages(nextPackages)
        setInstances(nextInstances)
      }
    )
    return () => {
      active = false
    }
  }, [revision, runtime])

  const createDraft = async () => {
    const trimmed = draftName.trim()
    if (!trimmed) return
    const id = `user.${draftDomain}.${trimmed
      .normalize("NFKC")
      .toLocaleLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")}.${Date.now().toString(36)}`
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

  const instantiate = async () => {
    if (!plan) return
    await runtime.service.instantiate({ plan, confirmed: true })
    setMessage(t("messages.instantiated"))
    setPlan(undefined)
    setInstances(await runtime.repository.listInstances())
  }

  const publish = async () => {
    if (!selected || selected.status !== "draft") return
    const suggestion = await runtime.service.getPublishSuggestion(selected.id)
    const published = await runtime.service.publish(selected.id, {
      expectedRevision: selected.revision,
      confirmedBump: suggestion.bump as TemplateVersionBump,
    })
    setSelectionKey(`hash:${published.contentHash}`)
    setMessage(t("messages.published", { version: published.version }))
  }

  const exportSelected = async () => {
    if (!selected?.version) return
    const exported = await runtime.service.exportPackage({
      id: `${selected.id}.package`,
      version: selected.version,
      name: selected.metadata.name,
      definitionIds: [{ id: selected.id, version: selected.version }],
    })
    downloadPackage(exported.bytes, `${selected.id}-${selected.version}.cognia-template`)
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

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-4" data-testid="template-studio">
      <FeaturePageHeader
        icon={<FileArchiveIcon />}
        title={t("title")}
        description={t("description")}
        className="rounded-xl border shadow-sm"
        actions={
          platform === "mobile" ? null : (
            <div className="flex items-center gap-2">
              <input
                ref={importRef}
                type="file"
                accept=".cognia-template,application/zip"
                className="hidden"
                onChange={(event) => void inspectImport(event.target.files?.[0])}
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

      <Tabs defaultValue="library" className="min-h-0 flex-1">
        <TabsList className="flex w-full justify-start overflow-x-auto">
          <TabsTrigger value="library">{t("tabs.library")}</TabsTrigger>
          <TabsTrigger value="drafts">{t("tabs.drafts")}</TabsTrigger>
          <TabsTrigger value="published">{t("tabs.published")}</TabsTrigger>
          <TabsTrigger value="packages">{t("tabs.packages")}</TabsTrigger>
          <TabsTrigger value="instances">{t("tabs.instances")}</TabsTrigger>
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
                <Select value={domain} onValueChange={(value) => setDomain(value as typeof domain)}>
                  <SelectTrigger aria-label={t("filters.domain")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t("filters.allDomains")}</SelectItem>
                    {FULL_DOMAINS.map((item) => (
                      <SelectItem key={item} value={item}>
                        {t(`domains.${item}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={trust} onValueChange={(value) => setTrust(value as typeof trust)}>
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
              <div className="grid min-h-0 gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
                <div className="grid content-start gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {rows.map((definition) => (
                    <Card
                      key={`${definition.id}@${definition.version ?? definition.revision}`}
                      role="button"
                      tabIndex={0}
                      className={
                        selected?.contentHash === definition.contentHash ? "border-primary" : ""
                      }
                      onClick={() => {
                        setSelectionKey(`hash:${definition.contentHash}`)
                        setBindings({})
                        setPlan(undefined)
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          setSelectionKey(`hash:${definition.contentHash}`)
                        }
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
                </div>
                <TemplateInspector
                  definition={selected}
                  bindings={bindings}
                  setBindings={setBindings}
                  plan={plan}
                  mobile={platform === "mobile"}
                  onPreflight={() => void runPreflight()}
                  onInstantiate={() => void instantiate()}
                  onPublish={() => void publish()}
                  onExport={() => void exportSelected()}
                  t={t}
                />
              </div>
            </TabsContent>
          )
        })}
        <TabsContent value="packages">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {packages.map((item) => (
              <Card key={item.key}>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <FileArchiveIcon className="size-4" />
                    {item.manifest.name}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-1 text-sm text-muted-foreground">
                  <p>{item.key}</p>
                  <p>{t(`trust.${item.trust}`)}</p>
                  <p className="font-mono text-xs">{item.fingerprint}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </TabsContent>
        <TabsContent value="instances">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {instances.map((instance) => (
              <Card key={instance.id}>
                <CardHeader>
                  <CardTitle className="text-base">{instance.source.definitionId}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-1 text-sm text-muted-foreground">
                  <p>{instance.source.version ?? t("status.draft")}</p>
                  <p>{t("instances.resources", { count: instance.resources.length })}</p>
                  {instance.detachedAt ? (
                    <Badge variant="outline">{t("instances.detached")}</Badge>
                  ) : null}
                </CardContent>
              </Card>
            ))}
          </div>
        </TabsContent>
      </Tabs>

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
            <Button onClick={() => void createDraft()} disabled={!draftName.trim()}>
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
              <Alert variant="destructive">
                <AlertTriangleIcon />
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
            <Button onClick={() => void confirmImport()}>{t("actions.confirmImport")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function TemplateInspector({
  definition,
  bindings,
  setBindings,
  plan,
  mobile,
  onPreflight,
  onInstantiate,
  onPublish,
  onExport,
  t,
}: {
  definition?: TemplateDefinitionEnvelope
  bindings: Record<string, string>
  setBindings(value: Record<string, string>): void
  plan?: TemplatePreflightPlan
  mobile: boolean
  onPreflight(): void
  onInstantiate(): void
  onPublish(): void
  onExport(): void
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
        {definition.inputs.map((input) => (
          <div key={input.id} className="space-y-2">
            <Label htmlFor={`binding-${input.id}`}>
              {input.label}
              {input.required ? ` ${t("inspector.required")}` : ""}
            </Label>
            <Input
              id={`binding-${input.id}`}
              value={bindings[input.id] ?? ""}
              onChange={(event) => setBindings({ ...bindings, [input.id]: event.target.value })}
              placeholder={t(`inputKinds.${input.kind}`)}
            />
          </div>
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
          {catalogOnly ? (
            <Badge variant="outline">{t("inspector.readOnly")}</Badge>
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
              {t("inspector.payload")}
              <ChevronDownIcon className="size-4 transition-transform group-data-[state=open]/collapsible:rotate-180" />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-muted p-3 text-xs">
              {JSON.stringify(definition.payload, null, 2)}
            </pre>
          </CollapsibleContent>
        </Collapsible>
      </CardContent>
    </Card>
  )
}
