"use client"

/**
 * Add or edit one tenant image (ADR-0182).
 *
 * The image is typed as a reference and then resolved: the entry is pinned to
 * the digest the registry names for it now, and its user is what the
 * registry's config says. Changing the reference drops the resolution, so an
 * entry can never be saved with a digest that belongs to an earlier text.
 *
 * GPU size classes are listed and cannot be chosen (Working Rule 7: dormant
 * at `SizeClassView.gpu`, labeled here, pinned by this component's test) —
 * admission would refuse any run that used one.
 */

import { useMemo, useState, type Dispatch, type SetStateAction } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { CatalogProblemText } from "@/components/settings/image-catalog/catalog-problem-text"
import { ResponsiveFormDialog } from "@/components/shared/responsive-form-dialog"
import {
  CatalogProblemError,
  type CatalogProblem,
  type CatalogWriteResult,
} from "@/hooks/sandbox/use-image-catalog"
import {
  draftFromRecord,
  emptyCatalogDraft,
  resolvedImageReference,
  toggleSizeClass,
  validateCatalogDraft,
  withDefaultSizeClass,
  type CatalogDraftField,
  type CatalogDraftProblem,
  type CatalogEntryDraft,
  type ResolvedCatalogImage,
} from "@/lib/project-environment/catalog-entry-draft"
import type { CatalogEntryRecord, CatalogRows } from "@/lib/project-environment/environment-client"
import type { IsolationTier } from "@/types/sandbox/environment-spec"

const TIERS: readonly IsolationTier[] = ["container", "gvisor", "vm"]

const PROBLEM_KEYS: Record<CatalogDraftProblem["code"], string | undefined> = {
  catalog_entry_invalid: undefined,
  catalog_entry_unpinned: "imageUnpinned",
  image_unresolved: "imageUnresolved",
  image_user_ambiguous: "imageUserAmbiguous",
}

export interface ImageCatalogEntryEditorProps {
  open: boolean
  onOpenChange(open: boolean): void
  /** The entry being edited; absent to add one. */
  existing?: CatalogEntryRecord
  facts: CatalogRows["facts"]
  busy: boolean
  inspect(reference: string): Promise<ResolvedCatalogImage>
  save(draft: CatalogEntryDraft, existing?: CatalogEntryRecord): Promise<CatalogWriteResult>
}

function initialReference(existing: CatalogEntryRecord | undefined, draft: CatalogEntryDraft) {
  if (draft.image) return resolvedImageReference(draft.image)
  if (!existing) return ""
  const { image } = existing
  return `${image.registry}/${image.repository}:${image.tag ?? "latest"}`
}

/**
 * Everything one open of the editor has typed, resolved or been told. It
 * lives in `ImageCatalogEntryEditor`, above the responsive shell, because the
 * shell remounts its body when the window crosses the phone breakpoint.
 */
interface EditorSession {
  /** Bumped on every reset, so a late registry or save answer for an earlier session is dropped. */
  generation: number
  /** The entry this session edits; kept so the title holds while the shell animates out. */
  existing?: CatalogEntryRecord
  draft: CatalogEntryDraft
  reference: string
  /** The text the current `draft.image` was resolved from. */
  resolvedFrom: string
  resolving: boolean
  inspectProblem?: CatalogProblem
  saveProblem?: CatalogProblem
  attempted: boolean
}

function startSession(
  existing: CatalogEntryRecord | undefined,
  facts: CatalogRows["facts"],
  generation: number
): EditorSession {
  const draft = seed(existing, facts)
  const reference = initialReference(existing, draft)
  return {
    generation,
    existing,
    draft,
    reference,
    resolvedFrom: draft.image ? reference : "",
    resolving: false,
    attempted: false,
  }
}

/** Which entry an open editor belongs to; `null` while closed. */
function sessionKey(open: boolean, existing: CatalogEntryRecord | undefined): string | null {
  if (!open) return null
  return existing ? `edit:${existing.id}` : "create"
}

export function ImageCatalogEntryEditor({
  open,
  onOpenChange,
  existing,
  facts,
  busy,
  inspect,
  save,
}: ImageCatalogEntryEditorProps) {
  const t = useTranslations("settings.imageCatalog")
  const tEditor = useTranslations("settings.imageCatalog.editor")

  // Every open starts from the entry as saved, and so does switching to a
  // different entry while open, so a cancelled edit leaves nothing behind.
  // Closing keeps the session, so the shell does not flash an empty form while
  // it animates out. Reset during render (not in an effect) per React's
  // "adjusting state when a prop changes".
  const key = sessionKey(open, existing)
  const [session, setSession] = useState<EditorSession>(() => startSession(existing, facts, 0))
  const [seenKey, setSeenKey] = useState(key)
  if (key !== seenKey) {
    setSeenKey(key)
    if (key !== null) setSession(startSession(existing, facts, session.generation + 1))
  }

  const problems = useMemo(() => validateCatalogDraft(session.draft), [session.draft])

  const close = () => onOpenChange(false)

  const onSave = async () => {
    const { generation, draft, existing: editing } = session
    setSession((prev) => ({ ...prev, attempted: true, saveProblem: undefined }))
    if (problems.length > 0) return
    const result = await save(draft, editing)
    if (result.ok) {
      toast.success(tEditor("saved", { label: draft.label.trim() }))
      close()
    } else {
      setSession((prev) =>
        prev.generation === generation ? { ...prev, saveProblem: result.problem } : prev
      )
    }
  }

  return (
    <ResponsiveFormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={
        session.existing
          ? tEditor("editTitle", { label: session.existing.label })
          : tEditor("createTitle")
      }
      description={t("description")}
      contentClassName="sm:max-w-lg"
      bodyClassName="gap-4"
      testid="image-catalog-editor"
      footer={
        <>
          <Button type="button" variant="outline" onClick={close}>
            {tEditor("cancel")}
          </Button>
          <Button type="button" disabled={busy || session.resolving} onClick={() => void onSave()}>
            {busy ? tEditor("saving") : tEditor("save")}
          </Button>
        </>
      }
    >
      <EditorFields
        session={session}
        setSession={setSession}
        problems={problems}
        facts={facts}
        inspect={inspect}
      />
    </ResponsiveFormDialog>
  )
}

/**
 * The editor's fields. Holds no state of its own: it is the part the shell
 * remounts, so the session it edits belongs to the caller.
 */
function EditorFields({
  session,
  setSession,
  problems,
  facts,
  inspect,
}: {
  session: EditorSession
  setSession: Dispatch<SetStateAction<EditorSession>>
  problems: readonly CatalogDraftProblem[]
  facts: CatalogRows["facts"]
  inspect: ImageCatalogEntryEditorProps["inspect"]
}) {
  const t = useTranslations("settings.imageCatalog")
  const tEditor = useTranslations("settings.imageCatalog.editor")
  const tTier = useTranslations("projectEnvironment.runtime.tier")

  const { draft, reference, resolving, inspectProblem, saveProblem, attempted } = session
  const setDraft = (update: (prev: CatalogEntryDraft) => CatalogEntryDraft) =>
    setSession((prev) => ({ ...prev, draft: update(prev.draft) }))

  const problemFor = (field: CatalogDraftField) =>
    attempted ? problems.find((problem) => problem.field === field) : undefined

  const onReferenceChange = (value: string) => {
    setSession((prev) => {
      const next = { ...prev, reference: value, inspectProblem: undefined }
      if (value.trim() === prev.resolvedFrom.trim()) return next
      const { image: _dropped, ...rest } = prev.draft
      return { ...next, draft: rest }
    })
  }

  const onResolve = async () => {
    const { generation } = session
    const requested = reference
    const current = (prev: EditorSession) => prev.generation === generation
    setSession((prev) => ({ ...prev, resolving: true, inspectProblem: undefined }))
    try {
      const image = await inspect(requested)
      setSession((prev) =>
        current(prev) ? { ...prev, draft: { ...prev.draft, image }, resolvedFrom: requested } : prev
      )
    } catch (cause) {
      const problem: CatalogProblem =
        cause instanceof CatalogProblemError
          ? cause.problem
          : { code: "unknown", message: cause instanceof Error ? cause.message : String(cause) }
      setSession((prev) => (current(prev) ? { ...prev, inspectProblem: problem } : prev))
    } finally {
      setSession((prev) => (current(prev) ? { ...prev, resolving: false } : prev))
    }
  }

  const imageProblem = problemFor("image")
  const chosen = new Set(draft.sizeClassIds)
  const selectable = facts.sizeClasses.filter((sizeClass) => !sizeClass.gpu)
  const isEditing = session.existing !== undefined

  return (
    <>
      <FieldBlock
        id="image-catalog-id"
        label={tEditor("id")}
        hint={tEditor("idHint")}
        problem={problemFor("id") ? tEditor("problem.id") : undefined}
      >
        <Input
          id="image-catalog-id"
          value={draft.id}
          disabled={isEditing}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setDraft((prev) => ({ ...prev, id: event.target.value }))}
        />
      </FieldBlock>

      <FieldBlock
        id="image-catalog-label"
        label={tEditor("label")}
        problem={problemFor("label") ? tEditor("problem.label") : undefined}
      >
        <Input
          id="image-catalog-label"
          value={draft.label}
          onChange={(event) => setDraft((prev) => ({ ...prev, label: event.target.value }))}
        />
      </FieldBlock>

      <FieldBlock
        id="image-catalog-description"
        label={tEditor("description")}
        problem={problemFor("description") ? tEditor("problem.description") : undefined}
      >
        <Textarea
          id="image-catalog-description"
          value={draft.description}
          rows={2}
          onChange={(event) => setDraft((prev) => ({ ...prev, description: event.target.value }))}
        />
      </FieldBlock>

      <FieldBlock
        id="image-catalog-image"
        label={tEditor("image")}
        problem={
          imageProblem && PROBLEM_KEYS[imageProblem.code]
            ? tEditor(`problem.${PROBLEM_KEYS[imageProblem.code]}`)
            : undefined
        }
      >
        <div className="flex gap-2">
          <Input
            id="image-catalog-image"
            value={reference}
            placeholder={tEditor("imagePlaceholder")}
            autoComplete="off"
            spellCheck={false}
            className="font-mono text-xs"
            onChange={(event) => onReferenceChange(event.target.value)}
          />
          <Button
            type="button"
            variant="secondary"
            disabled={resolving || reference.trim() === ""}
            onClick={() => void onResolve()}
          >
            {resolving ? tEditor("resolving") : tEditor("resolve")}
          </Button>
        </div>
        {inspectProblem ? <CatalogProblemText problem={inspectProblem} /> : null}
        {draft.image ? (
          <div className="space-y-0.5 text-xs text-muted-foreground" data-testid="resolved-image">
            <p className="break-all">
              {tEditor("resolved", { reference: resolvedImageReference(draft.image) })}
            </p>
            {draft.image.user === null ? null : (
              <p>
                {draft.image.user
                  ? tEditor("resolvedUser", { user: draft.image.user })
                  : tEditor("resolvedRoot")}
              </p>
            )}
            {draft.image.platforms.length > 0 ? (
              <p>{tEditor("platforms", { platforms: draft.image.platforms.join(", ") })}</p>
            ) : null}
          </div>
        ) : null}
      </FieldBlock>

      <FieldBlock
        id="image-catalog-floor"
        label={tEditor("floor")}
        hint={tEditor("floorHint", { tier: tTier(facts.floor) })}
      >
        <Select
          value={draft.isolationFloor}
          onValueChange={(value) =>
            setDraft((prev) => ({ ...prev, isolationFloor: value as IsolationTier }))
          }
        >
          <SelectTrigger id="image-catalog-floor" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TIERS.map((tier) => (
              <SelectItem key={tier} value={tier}>
                {tTier(tier)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldBlock>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{tEditor("sizes")}</legend>
        {facts.sizeClasses.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("sizes.empty")}</p>
        ) : null}
        {facts.sizeClasses.map((sizeClass) => {
          const id = `image-catalog-size-${sizeClass.id}`
          if (sizeClass.gpu) {
            return (
              <div
                key={sizeClass.id}
                className="flex items-center gap-2 text-sm text-muted-foreground"
                data-dormant="gpu"
              >
                <Checkbox id={id} checked={false} disabled />
                <Label htmlFor={id} className="font-normal">
                  {t("sizes.gpuDormant", {
                    count: sizeClass.gpu.count,
                    resource: sizeClass.gpu.resourceName,
                  })}
                </Label>
              </div>
            )
          }
          return (
            <div key={sizeClass.id} className="flex items-center gap-2">
              <Checkbox
                id={id}
                checked={chosen.has(sizeClass.id)}
                onCheckedChange={(checked) =>
                  setDraft((prev) => ({
                    ...prev,
                    sizeClassIds: toggleSizeClass(
                      prev.sizeClassIds,
                      sizeClass.id,
                      checked === true
                    ),
                  }))
                }
              />
              <Label htmlFor={id} className="font-normal">
                {t("sizes.spec", {
                  label: sizeClass.label,
                  cpu: sizeClass.cpuMillis / 1000,
                  memory: sizeClass.memoryMib,
                  storage: sizeClass.ephemeralStorageMib,
                  volume: sizeClass.volumeMib,
                })}
              </Label>
            </div>
          )
        })}
        {problemFor("sizeClassIds") ? (
          <p className="text-xs text-destructive">{tEditor("problem.sizeClassIds")}</p>
        ) : null}
      </fieldset>

      {draft.sizeClassIds.length > 1 ? (
        <FieldBlock id="image-catalog-default-size" label={tEditor("defaultSize")}>
          <Select
            value={draft.sizeClassIds[0]}
            onValueChange={(value) =>
              setDraft((prev) => ({
                ...prev,
                sizeClassIds: withDefaultSizeClass(prev.sizeClassIds, value),
              }))
            }
          >
            <SelectTrigger id="image-catalog-default-size" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {draft.sizeClassIds.map((id) => (
                <SelectItem key={id} value={id}>
                  {selectable.find((sizeClass) => sizeClass.id === id)?.label ?? id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FieldBlock>
      ) : null}

      {saveProblem ? <CatalogProblemText problem={saveProblem} /> : null}
    </>
  )
}

function seed(
  existing: CatalogEntryRecord | undefined,
  facts: CatalogRows["facts"]
): CatalogEntryDraft {
  if (existing) return draftFromRecord(existing)
  return emptyCatalogDraft({
    isolationFloor: facts.floor,
    sizeClassId: facts.sizeClasses.find((sizeClass) => !sizeClass.gpu)?.id,
  })
}

function FieldBlock({
  id,
  label,
  hint,
  problem,
  children,
}: {
  id: string
  label: string
  hint?: string
  problem?: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      {problem ? <p className="text-xs text-destructive">{problem}</p> : null}
    </div>
  )
}
