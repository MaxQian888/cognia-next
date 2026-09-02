"use client"

/**
 * Phone-shaped view of the template catalog (ADR-0100).
 *
 * The Studio graded itself on `usePlatform()` alone, so a 375px browser window,
 * which is not a native shell and therefore not `"mobile"`, was handed the full
 * desktop three-pane authoring workspace. Capability and presentation are two
 * axes. `usePlatform()` still decides what a surface may DO, so authoring stays
 * off native mobile where none of the six domain editors exist. This component
 * decides what a narrow viewport LOOKS like, and the route picks between them
 * on `useCompactLayout()`.
 *
 * What a phone gets is find, inspect, instantiate, and fork. Fork is here
 * because it is a one-tap adoption that needs no editor: it puts a copy in your
 * own library, with its origin recorded, ready to edit on a desktop. Publish,
 * export, package import and draft editing stay off, and the sheet says why
 * rather than leaving a user to notice an absence.
 *
 * Filters and selection live in the URL through `useTemplateRouteState`, shared
 * with the Studio, so a link opens the same template and the same narrowed list
 * on either. Before this the phone read nothing from the URL and a deep link
 * landed on an unfiltered catalog.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  FileArchiveIcon,
  GitForkIcon,
  SearchIcon,
} from "lucide-react"

import { EmptyState } from "@/components/mobile/empty-state"
import { ResponsiveDetailSheet } from "@/components/shared/responsive-detail-sheet"
import { TemplateBindingField } from "@/components/templates/template-binding-field"
import { TemplateOriginCard } from "@/components/templates/template-origin-card"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Surface } from "@/components/surface/surface"
import { useTemplateRouteState } from "@/hooks/templates/use-template-route-state"
import { useScopedTemplateCatalog } from "@/hooks/templates/use-scoped-template-catalog"
import { usePlatform } from "@/hooks/use-platform"
import type { TemplateDefinitionEnvelope, TemplateDomain } from "@/lib/templates/contracts"
import { TEMPLATE_FULL_DOMAINS } from "@/lib/templates/contracts"
import { getTemplateRuntime } from "@/lib/templates/runtime"
import { makeTemplateDraftId } from "@/lib/templates/draft-id"
import type { TemplateDerivation } from "@/lib/templates/repository"
import type { TemplatePreflightPlan } from "@/lib/templates/service"
import { isWorkflowNodeGroupDefinition } from "@/lib/workflow/node-groups/materialize"
import { TemplatesFilterSheet } from "./templates-filter-sheet"

/** Widened, because `includes` on the frozen tuple only accepts its own members. */
const FULL_DOMAINS: TemplateDomain[] = [...TEMPLATE_FULL_DOMAINS]

export function TemplatesMobileBody() {
  const t = useTranslations("templateStudio")
  const platform = usePlatform()
  const templatePlatform = platform === "mobile" ? "mobile" : platform === "web" ? "web" : "desktop"
  const runtime = useMemo(() => getTemplateRuntime(), [])
  const route = useTemplateRouteState()

  const { definitions, tierOf, hiddenCount } = useScopedTemplateCatalog(
    {
      text: route.query,
      platform: templatePlatform,
      ...(route.domain === "all" ? {} : { domain: route.domain }),
      ...(route.trust === "all" ? {} : { trust: route.trust }),
    },
    { tier: route.scope }
  )

  // Only the domains this catalog actually holds, so the filter sheet never
  // offers a facet that can only ever empty the list.
  const presentDomains = useMemo(() => {
    const seen = new Set<TemplateDomain>()
    for (const definition of definitions) seen.add(definition.domain)
    return [...seen].sort()
  }, [definitions])

  const selected = useMemo(
    () => definitions.find((definition) => definition.id === route.definitionId),
    [definitions, route.definitionId]
  )

  const [bindings, setBindings] = useState<Record<string, string>>({})
  const [plan, setPlan] = useState<TemplatePreflightPlan>()
  const [derivation, setDerivation] = useState<TemplateDerivation>()
  /**
   * The newer upstream release a fork could take, when there is one.
   *
   * Read here for the same reason the desktop inspector reads it: the lineage
   * and the upstream lookup both live in the repository, and the envelope the
   * selection carries deliberately does not know where it came from. The phone
   * passed a hard-coded `undefined`, so every fork on a phone claimed to be up
   * to date with an upstream it had never asked about.
   */
  const [upstream, setUpstream] = useState<TemplateDefinitionEnvelope>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [message, setMessage] = useState<string>()

  // Reset the per-template working state when the selection changes. Adjusted
  // during render rather than in an effect, so no paint shows one template's
  // preflight against another's inputs.
  //
  // Seeded `undefined` rather than with the current selection: seeded with it,
  // a DEEP LINK arrived already "inspected" and the lineage below was never
  // fetched, so `/templates?definition=…` opened a fork with no origin card at
  // all while the same template tapped from the list had one.
  const [inspectedId, setInspectedId] = useState<string | undefined>(undefined)
  if (route.definitionId !== inspectedId) {
    setInspectedId(route.definitionId)
    setBindings({})
    setPlan(undefined)
    setError(undefined)
    setMessage(undefined)
    setDerivation(undefined)
    setUpstream(undefined)
    if (route.definitionId) {
      void Promise.all([
        runtime.service.getDerivation(route.definitionId),
        runtime.service.findUpstreamUpdate(route.definitionId),
      ])
        .then(([nextDerivation, nextUpstream]) => {
          setDerivation(nextDerivation)
          setUpstream(nextUpstream)
        })
        .catch(() => {
          setDerivation(undefined)
          setUpstream(undefined)
        })
    }
  }

  /**
   * A node group is `domain: "workflow"` carrying a subgraph payload, and the
   * workflow adapter reads `draft.name` off it and throws. Same judgement the
   * desktop inspector makes, for the same reason: instantiating one is a crash,
   * not a feature the small screen is missing.
   */
  const instantiable =
    selected !== undefined &&
    FULL_DOMAINS.includes(selected.domain) &&
    !isWorkflowNodeGroupDefinition(selected)

  const run = (fn: () => Promise<void>) => () => {
    setBusy(true)
    setError(undefined)
    void fn()
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false))
  }

  const preflight = async () => {
    if (!selected) return
    setPlan(
      await runtime.service.preflight({
        definitionId: selected.id,
        ...(selected.version ? { version: selected.version } : {}),
        platform: templatePlatform,
        bindings,
      })
    )
  }

  const instantiate = async () => {
    if (!plan || plan.status === "blocked") return
    await runtime.service.instantiate({ plan, confirmed: true })
    setMessage(t("messages.instantiated"))
    setPlan(undefined)
  }

  /**
   * Adoption, not authoring. The copy lands in the user's own library with its
   * origin recorded, which is what makes it editable later on a desktop and
   * updatable against upstream in the meantime.
   */
  const fork = async () => {
    if (!selected) return
    const forked = await runtime.service.fork(selected.id, {
      ...(selected.version ? { version: selected.version } : {}),
      newId: makeTemplateDraftId(selected.domain, `${selected.metadata.name} copy`),
    })
    setMessage(t("messages.forked", { id: forked.id }))
  }

  return (
    // `data-bg-target` is what opts a subtree into the wallpaper layer
    // (`app/globals.css`). `FeaturePageShell` owns the mark for every route
    // that goes through it, and this body replaces the shell on the compact
    // branch, so without it a user with a background set saw it everywhere
    // except here. Same reasoning `squads-mobile-body.tsx` writes down.
    <div
      className="flex h-full min-h-0 flex-col"
      data-bg-target="chat"
      data-testid="templates-mobile-body"
    >
      <div className="flex shrink-0 items-center gap-2 p-3">
        <div className="relative min-w-0 flex-1">
          <SearchIcon className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={route.query}
            onChange={(event) => route.setQuery(event.target.value)}
            placeholder={t("filters.search")}
            aria-label={t("filters.search")}
            className="pl-9"
          />
        </div>
        <div className="relative shrink-0">
          <TemplatesFilterSheet route={route} domains={presentDomains} />
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-6">
        {definitions.length === 0 ? (
          <EmptyState icon={FileArchiveIcon} title={t("empty.noResults")} />
        ) : (
          definitions.map((definition) => (
            <TemplateCard
              key={`${definition.id}@${definition.version ?? definition.revision}`}
              definition={definition}
              tier={t(`scopes.${tierOf(definition)}`)}
              domainLabel={t(`domains.${definition.domain}`)}
              statusLabel={t(`status.${definition.status}`)}
              trustLabel={t(`trust.${definition.provenance.trust}`)}
              fallbackDescription={t("empty.noDescription")}
              onOpen={() => route.setDefinitionId(definition.id)}
            />
          ))
        )}
        {hiddenCount > 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="templates-mobile-hidden">
            {t("filters.hiddenHere", { count: hiddenCount })}
          </p>
        ) : null}
      </div>

      <ResponsiveDetailSheet
        open={selected !== undefined}
        onOpenChange={(open) => !open && route.setDefinitionId(undefined)}
        title={selected?.metadata.name ?? ""}
        description={selected?.metadata.description || t("empty.noDescription")}
      >
        {selected ? (
          <div className="space-y-4">
            <p className="font-mono text-xs text-muted-foreground">
              {selected.id}
              {selected.version ? `@${selected.version}` : ""}
            </p>
            {/* Read-only on a phone: the merge it offers lands in a draft
                editor that only exists on the desktop. Saying an update is
                there and naming where it can be taken beats hiding the fact
                that upstream has moved — which is what passing `undefined`
                here did. */}
            <TemplateOriginCard
              derivation={derivation}
              upstream={upstream}
              onReviewUpdate={() => {}}
              onDetach={() => {}}
              readOnly
            />
            {derivation && upstream ? (
              <p
                className="text-xs text-muted-foreground"
                data-testid="templates-mobile-upstream-desktop"
              >
                {t("mobile.reviewUpdateOnDesktop")}
              </p>
            ) : null}
            {instantiable ? (
              selected.inputs.map((input) => (
                <TemplateBindingField
                  key={input.id}
                  input={input}
                  value={bindings[input.id] ?? ""}
                  onChange={(next) => setBindings({ ...bindings, [input.id]: next })}
                />
              ))
            ) : (
              <Badge variant="outline" data-testid="templates-mobile-read-only">
                {isWorkflowNodeGroupDefinition(selected)
                  ? t("inspector.nodeGroup")
                  : t("inspector.readOnly")}
              </Badge>
            )}
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
            {message ? (
              <Alert data-testid="templates-mobile-message">
                <CheckCircle2Icon />
                <AlertDescription>{message}</AlertDescription>
              </Alert>
            ) : null}
            {error ? (
              <Alert variant="destructive">
                <AlertTriangleIcon />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {instantiable ? (
                <>
                  <Button variant="outline" disabled={busy} onClick={run(preflight)}>
                    {t("actions.preflight")}
                  </Button>
                  {plan && plan.status !== "blocked" ? (
                    <Button disabled={busy} onClick={run(instantiate)}>
                      {t("actions.instantiate")}
                    </Button>
                  ) : null}
                </>
              ) : null}
              <Button
                variant="outline"
                disabled={busy}
                onClick={run(fork)}
                data-testid="templates-mobile-fork"
              >
                <GitForkIcon className="size-4" />
                {t("actions.fork")}
              </Button>
            </div>
            {/* Said, not hidden. A control that simply is not there reads as a
                bug, where a sentence naming where authoring lives does not. */}
            <p className="text-xs text-muted-foreground" data-testid="templates-mobile-authoring">
              {t("mobile.authoringOnDesktop")}
            </p>
          </div>
        ) : null}
      </ResponsiveDetailSheet>
    </div>
  )
}

function TemplateCard({
  definition,
  tier,
  domainLabel,
  statusLabel,
  trustLabel,
  fallbackDescription,
  onOpen,
}: {
  definition: TemplateDefinitionEnvelope
  tier: string
  domainLabel: string
  statusLabel: string
  trustLabel: string
  fallbackDescription: string
  onOpen: () => void
}) {
  return (
    <Surface asChild layer="raised" radius="control">
      <button
        type="button"
        className="w-full space-y-1.5 p-3 text-left"
        onClick={onOpen}
        data-testid={`templates-mobile-card-${definition.id}`}
      >
        <span className="flex items-start justify-between gap-2">
          <span className="min-w-0 flex-1 truncate font-medium">{definition.metadata.name}</span>
          <Badge variant="outline" className="shrink-0">
            {domainLabel}
          </Badge>
        </span>
        <span className="line-clamp-2 block text-sm text-muted-foreground">
          {definition.metadata.description || fallbackDescription}
        </span>
        {/* Scope, version and trust on the card itself. A catalog mixing
            built-ins, plugin contributions and your own forks is unreadable
            when every row looks the same. */}
        <span className="flex flex-wrap items-center gap-1">
          <Badge variant="outline">{tier}</Badge>
          <Badge variant="secondary">{statusLabel}</Badge>
          <Badge variant="secondary">{trustLabel}</Badge>
          {definition.version ? (
            <span className="font-mono text-[11px] text-muted-foreground">
              v{definition.version}
            </span>
          ) : null}
        </span>
      </button>
    </Surface>
  )
}
