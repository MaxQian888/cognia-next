"use client"

/**
 * Phone-shaped view of the template catalog (ADR-0100).
 *
 * The Studio graded itself on `usePlatform()` alone, so a 375px browser window,
 * which is not a native shell and therefore not `"mobile"`, was handed the full
 * desktop three-pane authoring workspace: filters, draft editor, package
 * import, publish. Capability and presentation are two axes. `usePlatform()`
 * still decides what a surface may DO, so authoring stays off native mobile
 * where none of the six domain editors exist. This component decides what a
 * narrow viewport LOOKS like, and the route picks between them on
 * `useCompactLayout()`.
 *
 * What a phone gets is the consumer half of the Studio: find a template, see
 * what it will create, fill its inputs, preflight, instantiate. Authoring
 * (draft editing, publish, export, import, package management) is desktop-only
 * and is not hidden behind a disabled control here, because there is nothing on
 * this surface a user could enable to reach it.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { AlertTriangleIcon, CheckCircle2Icon, FileArchiveIcon, SearchIcon } from "lucide-react"

import { EmptyState } from "@/components/mobile/empty-state"
import { TemplateBindingField } from "@/components/templates/template-binding-field"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Surface } from "@/components/surface/surface"
import { useTemplateCatalog } from "@/hooks/use-template-catalog"
import { usePlatform } from "@/hooks/use-platform"
import type { TemplateDefinitionEnvelope, TemplateDomain } from "@/lib/templates/contracts"
import { TEMPLATE_FULL_DOMAINS } from "@/lib/templates/contracts"
import { getTemplateRuntime } from "@/lib/templates/runtime"
import type { TemplatePreflightPlan } from "@/lib/templates/service"
import { isWorkflowNodeGroupDefinition } from "@/lib/workflow/node-groups/materialize"

/** Widened, because `includes` on the frozen tuple only accepts its own members. */
const FULL_DOMAINS: TemplateDomain[] = [...TEMPLATE_FULL_DOMAINS]

export function TemplatesMobileBody() {
  const t = useTranslations("templateStudio")
  const platform = usePlatform()
  const templatePlatform = platform === "mobile" ? "mobile" : platform === "web" ? "web" : "desktop"
  const runtime = useMemo(() => getTemplateRuntime(), [])
  const [query, setQuery] = useState("")
  const { definitions } = useTemplateCatalog({ text: query, platform: templatePlatform })
  const [selected, setSelected] = useState<TemplateDefinitionEnvelope>()
  const [bindings, setBindings] = useState<Record<string, string>>({})
  const [plan, setPlan] = useState<TemplatePreflightPlan>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [done, setDone] = useState(false)

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

  const open = (definition: TemplateDefinitionEnvelope) => {
    setSelected(definition)
    setBindings({})
    setPlan(undefined)
    setError(undefined)
    setDone(false)
  }

  const run = (fn: () => Promise<void>) => () => {
    setBusy(true)
    setError(undefined)
    void fn()
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause))
      })
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
    setDone(true)
    setPlan(undefined)
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="templates-mobile-body">
      <div className="relative shrink-0 p-3">
        <SearchIcon className="absolute left-6 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("filters.search")}
          aria-label={t("filters.search")}
          className="pl-9"
        />
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-6">
        {definitions.length === 0 ? (
          <EmptyState icon={FileArchiveIcon} title={t("empty.noResults")} />
        ) : (
          definitions.map((definition) => (
            <Surface
              key={`${definition.id}@${definition.version ?? definition.revision}`}
              asChild
              layer="raised"
              radius="control"
            >
              <button
                type="button"
                className="w-full space-y-1.5 p-3 text-left"
                onClick={() => open(definition)}
              >
                <span className="flex items-start justify-between gap-2">
                  <span className="font-medium">{definition.metadata.name}</span>
                  <Badge variant="outline">{t(`domains.${definition.domain}`)}</Badge>
                </span>
                <span className="line-clamp-2 block text-sm text-muted-foreground">
                  {definition.metadata.description || t("empty.noDescription")}
                </span>
                <span className="flex flex-wrap gap-1">
                  <Badge variant="secondary">{t(`status.${definition.status}`)}</Badge>
                  <Badge variant="secondary">{t(`trust.${definition.provenance.trust}`)}</Badge>
                </span>
              </button>
            </Surface>
          ))
        )}
      </div>

      <Sheet open={Boolean(selected)} onOpenChange={(next) => !next && setSelected(undefined)}>
        <SheetContent side="bottom" className="max-h-[85svh] overflow-y-auto">
          {selected ? (
            <>
              <SheetHeader>
                <SheetTitle>{selected.metadata.name}</SheetTitle>
                <SheetDescription>
                  {selected.metadata.description || t("empty.noDescription")}
                </SheetDescription>
              </SheetHeader>
              <div className="space-y-4 px-4 pb-6">
                <p className="font-mono text-xs text-muted-foreground">
                  {selected.id}
                  {selected.version ? `@${selected.version}` : ""}
                </p>
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
                          <li key={`${issue.code}:${issue.path ?? ""}`}>
                            {t(`issues.${issue.code}`)}
                          </li>
                        ))}
                        {plan.operations.map((operation) => (
                          <li key={operation.id}>{t(`operations.${operation.kind}`)}</li>
                        ))}
                      </ul>
                    </AlertDescription>
                  </Alert>
                ) : null}
                {done ? (
                  <Alert>
                    <CheckCircle2Icon />
                    <AlertDescription>{t("messages.instantiated")}</AlertDescription>
                  </Alert>
                ) : null}
                {error ? (
                  <Alert variant="destructive">
                    <AlertTriangleIcon />
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                ) : null}
                {instantiable ? (
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" disabled={busy} onClick={run(preflight)}>
                      {t("actions.preflight")}
                    </Button>
                    {plan && plan.status !== "blocked" ? (
                      <Button disabled={busy} onClick={run(instantiate)}>
                        {t("actions.instantiate")}
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  )
}
