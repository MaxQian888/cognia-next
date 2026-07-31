"use client"

/**
 * Guided add-source flow: pick type → input → review/confirm → commit.
 *
 * The staging layer (`lib/twin/ingest/stage`) extracts content without
 * writing Dexie; the review step (`StagedSourceReview`) previews it; only
 * the confirm click commits the ticked subset as `status:"pending"` twin
 * sources. Rendered inline by the creation wizard's Sources step and inside
 * a Dialog by the Sources tab (`TwinAddSourceDialog`).
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  FileTextIcon,
  GlobeIcon,
  ClipboardPasteIcon,
  GitBranchIcon,
  BookOpenTextIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { commitStagedSources, type IngestError, type StagedSource } from "@/lib/twin/ingest/stage"
import {
  FileSourceInput,
  GitSourceInput,
  LarkSourceInput,
  PasteSourceInput,
  UrlSourceInput,
  useTauriAvailable,
  type FileNotice,
} from "./source-inputs"
import { StagedSourceReview } from "./staged-source-review"

export type AddSourceType = "file" | "url" | "lark" | "paste" | "git"

type FlowPhase =
  | { step: "pick" }
  | { step: "input"; type: AddSourceType }
  | { step: "review"; type: AddSourceType }

export interface AddSourceFlowProps {
  twinId: string
  /** Called after a successful commit with the number of sources created. */
  onAdded?: (count: number) => void
}

export function AddSourceFlow({ twinId, onAdded }: AddSourceFlowProps) {
  const t = useTranslations("twin.addSource")
  const tErr = useTranslations("twin.sourceUploader.errors")
  const renderError = (err: IngestError): string => tErr(err.code, err.params)

  const [phase, setPhase] = useState<FlowPhase>({ step: "pick" })
  const [busy, setBusy] = useState(false)
  const [committing, setCommitting] = useState(false)
  const [error, setError] = useState<IngestError | null>(null)
  const [staged, setStaged] = useState<StagedSource[]>([])
  const [notices, setNotices] = useState<FileNotice[] | undefined>(undefined)
  const [larkPrefill, setLarkPrefill] = useState<string | undefined>(undefined)
  const tauriAvailable = useTauriAvailable()

  const types: Array<{
    type: AddSourceType
    icon: typeof FileTextIcon
    disabled?: boolean
  }> = [
    { type: "file", icon: FileTextIcon },
    { type: "url", icon: GlobeIcon },
    { type: "lark", icon: BookOpenTextIcon },
    { type: "paste", icon: ClipboardPasteIcon },
    { type: "git", icon: GitBranchIcon, disabled: !tauriAvailable },
  ]

  const pickType = (type: AddSourceType) => {
    setError(null)
    setPhase({ step: "input", type })
  }

  const handleStaged = (items: StagedSource[], fileNotices?: FileNotice[]) => {
    if (phase.step !== "input") return
    setError(null)
    setStaged(items)
    setNotices(fileNotices)
    setPhase({ step: "review", type: phase.type })
  }

  const handleError = (err: IngestError) => {
    setError(err)
  }

  const handleConfirm = async (selected: StagedSource[]) => {
    setCommitting(true)
    try {
      const count = await commitStagedSources(twinId, selected)
      toast.success(t("added", { count }))
      setStaged([])
      setNotices(undefined)
      setPhase({ step: "pick" })
      onAdded?.(count)
    } catch (err) {
      setError({
        code: "parseFailed",
        params: { message: err instanceof Error ? err.message : String(err) },
      })
    } finally {
      setCommitting(false)
    }
  }

  const inputProps = {
    twinId,
    busy,
    setBusy,
    onStaged: handleStaged,
    onError: handleError,
  }

  return (
    <div
      className="@container/twin-add flex min-h-0 flex-col gap-3"
      data-testid="twin-add-source-flow"
    >
      {phase.step === "pick" ? (
        <div
          className="grid grid-cols-1 gap-2 @xs/twin-add:grid-cols-2 @lg/twin-add:grid-cols-3"
          role="group"
          aria-label={t("pickTypeLabel")}
        >
          {types.map(({ type, icon: Icon, disabled }) => (
            <button
              key={type}
              type="button"
              className="hover:bg-accent focus-visible:ring-ring flex items-start gap-2.5 rounded-md border p-3 text-left focus-visible:ring-2 focus-visible:outline-none disabled:opacity-50"
              onClick={() => pickType(type)}
              disabled={disabled}
              data-testid={`twin-add-source-type-${type}`}
            >
              <Icon className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm font-medium">{t(`type.${type}`)}</span>
                <span className="text-muted-foreground text-xs">{t(`typeDesc.${type}`)}</span>
              </span>
            </button>
          ))}
        </div>
      ) : null}

      {phase.step === "input" ? (
        <div className="flex flex-col gap-3">
          {phase.type === "file" ? <FileSourceInput {...inputProps} /> : null}
          {phase.type === "url" ? (
            <UrlSourceInput
              {...inputProps}
              onSwitchToLark={(url) => {
                setLarkPrefill(url)
                setError(null)
                setPhase({ step: "input", type: "lark" })
              }}
            />
          ) : null}
          {phase.type === "lark" ? (
            <LarkSourceInput {...inputProps} initialUrl={larkPrefill} />
          ) : null}
          {phase.type === "paste" ? <PasteSourceInput {...inputProps} /> : null}
          {phase.type === "git" ? <GitSourceInput {...inputProps} /> : null}
          <div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setError(null)
                setPhase({ step: "pick" })
              }}
              disabled={busy}
              data-testid="twin-add-source-back-to-pick"
            >
              {t("back")}
            </Button>
          </div>
        </div>
      ) : null}

      {phase.step === "review" ? (
        <StagedSourceReview
          staged={staged}
          notices={notices}
          committing={committing}
          renderError={renderError}
          onConfirm={(selected) => void handleConfirm(selected)}
          onBack={() => {
            setError(null)
            setPhase({ step: "input", type: phase.type })
          }}
        />
      ) : null}

      {error ? (
        <p className="text-destructive text-sm" role="alert" data-testid="twin-add-source-error">
          {renderError(error)}
        </p>
      ) : null}
    </div>
  )
}
