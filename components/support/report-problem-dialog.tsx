"use client"

/**
 * The one "Report a problem" dialog.
 *
 * Every surface that used to hand-roll a feedback flow — the Support Agent
 * strip, the mobile Feedback page, the error boundary — opens this instead.
 * The caller supplies what it knows (`context`); the dialog offers the
 * sections that can say something for that context, previews the redacted
 * result, and delivers through whichever channels the shell supports.
 *
 * All form state lives in {@link ReportProblemForm}, which only mounts while
 * the dialog is open, so every open starts clean without effect-driven resets.
 */

import { useEffect, useMemo, useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import {
  BugIcon,
  ChevronDownIcon,
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  SendIcon,
  ShieldCheckIcon,
} from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { buildSupportReport } from "@/lib/support-report/build"
import {
  deliverSupportReport,
  listAvailableSupportReportChannels,
  type SupportReportChannelDeps,
} from "@/lib/support-report/channels"
import {
  defaultSupportReportSectionIds,
  listAvailableSupportReportSections,
} from "@/lib/support-report/sections"
import type { SupportReportContext } from "@/lib/support-report/types"
import { trackEvent } from "@/lib/telemetry/events/track-event"
import { cn } from "@/lib/utils"

const PREVIEW_DEBOUNCE_MS = 350

const CHANNEL_ICONS: Record<string, typeof CopyIcon> = {
  copy: CopyIcon,
  download: DownloadIcon,
  issue: ExternalLinkIcon,
}

export interface ReportProblemDialogProps {
  /** What the opening surface knows. `description` is owned by the dialog. */
  context: Omit<SupportReportContext, "description">
  /** Seed for the description box (e.g. the Support conversation summary). */
  initialDescription?: string
  /** Rendered as the trigger; omit for a controlled dialog. */
  trigger?: ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** Channel seams — the error page passes its configured tracker. */
  channelDeps?: SupportReportChannelDeps
  /** The static global-error page has no Toaster mounted. */
  toastsEnabled?: boolean
}

export function ReportProblemDialog({
  context,
  initialDescription = "",
  trigger,
  open: controlledOpen,
  onOpenChange,
  channelDeps,
  toastsEnabled = true,
}: ReportProblemDialogProps) {
  const t = useTranslations("support.report")
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const open = controlledOpen ?? uncontrolledOpen
  const setOpen = (next: boolean) => {
    if (controlledOpen === undefined) setUncontrolledOpen(next)
    onOpenChange?.(next)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger ? <DialogTrigger asChild>{trigger}</DialogTrigger> : null}
      <DialogContent className="sm:max-w-xl" data-testid="report-problem-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BugIcon className="size-4 text-muted-foreground" aria-hidden="true" />
            {t("title")}
          </DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        {open && (
          <ReportProblemForm
            context={context}
            initialDescription={initialDescription}
            channelDeps={channelDeps}
            toastsEnabled={toastsEnabled}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

interface ReportProblemFormProps {
  context: Omit<SupportReportContext, "description">
  initialDescription: string
  channelDeps?: SupportReportChannelDeps
  toastsEnabled: boolean
}

function ReportProblemForm({
  context,
  initialDescription,
  channelDeps,
  toastsEnabled,
}: ReportProblemFormProps) {
  const t = useTranslations("support.report")
  const [description, setDescription] = useState(initialDescription)
  const sections = useMemo(() => listAvailableSupportReportSections(context), [context])
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(defaultSupportReportSectionIds(context))
  )
  const channels = useMemo(() => listAvailableSupportReportChannels(channelDeps), [channelDeps])
  const [previewOpen, setPreviewOpen] = useState(false)
  const [preview, setPreview] = useState<string | null>(null)
  const [previewFailed, setPreviewFailed] = useState(false)
  const [busyChannel, setBusyChannel] = useState<string | null>(null)

  const pinned = sections.filter((s) => s.pinned && s.id !== "description")
  const toggleable = sections.filter((s) => !s.pinned)
  const fullContext: SupportReportContext = useMemo(
    () => ({ ...context, description }),
    [context, description]
  )
  const sectionIds = useMemo(() => [...selected], [selected])

  useEffect(() => {
    void trackEvent("support.feedback.draft.opened", {
      surface: context.surface,
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    })
  }, [context.surface, context.sessionId])

  // Rebuild the preview while it is open. Debounced so typing in the
  // description box does not run the collectors on every keystroke.
  useEffect(() => {
    if (!previewOpen) return
    let cancelled = false
    const timer = setTimeout(() => {
      buildSupportReport({ context: fullContext, sectionIds })
        .then((report) => {
          if (cancelled) return
          setPreview(report.markdown)
          setPreviewFailed(false)
        })
        .catch(() => {
          if (cancelled) return
          setPreview(null)
          setPreviewFailed(true)
        })
    }, PREVIEW_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [previewOpen, fullContext, sectionIds])

  const toggleSection = (id: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  const channelLabel = (id: string) => {
    const spec = channels.find((c) => c.id === id)
    const key = `channel.${spec?.labelKey ?? id}`
    return t.has(key) ? t(key) : id
  }
  const sectionText = (key: string, fallback: string) =>
    t.has(`section.${key}`) ? t(`section.${key}`) : fallback

  const deliver = async (channelId: string) => {
    if (busyChannel) return
    setBusyChannel(channelId)
    try {
      const report = await buildSupportReport({ context: fullContext, sectionIds })
      await deliverSupportReport(channelId, report, channelDeps)
      void trackEvent("support.feedback.draft.exported", {
        surface: context.surface,
        channel: channelId,
        ...(context.sessionId ? { sessionId: context.sessionId } : {}),
      })
      if (toastsEnabled) {
        toast.success(
          t.has(`delivered.${channelId}`)
            ? t(`delivered.${channelId}`)
            : t("delivered.generic", { channel: channelLabel(channelId) })
        )
      }
    } catch {
      if (toastsEnabled) toast.error(t("failed"))
    } finally {
      setBusyChannel(null)
    }
  }

  return (
    <div className="space-y-4" data-testid="report-problem-form">
      <div className="space-y-1.5">
        <Label htmlFor="report-problem-description">{t("descriptionLabel")}</Label>
        <Textarea
          id="report-problem-description"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder={t("descriptionPlaceholder")}
          rows={4}
          className="max-h-48 resize-y text-sm"
        />
      </div>

      <fieldset className="space-y-2">
        <legend className="text-xs font-medium">{t("includeTitle")}</legend>
        {pinned.length > 0 && (
          <p className="text-[11px] text-muted-foreground">
            {t("alwaysIncluded", {
              items: pinned.map((s) => sectionText(s.labelKey, s.id)).join(" · "),
            })}
          </p>
        )}
        {toggleable.length > 0 && (
          <ul className="grid gap-1.5 sm:grid-cols-2" data-testid="report-problem-sections">
            {toggleable.map((section) => {
              const checked = selected.has(section.id)
              const inputId = `report-section-${section.id}`
              return (
                <li key={section.id}>
                  <label
                    htmlFor={inputId}
                    className={cn(
                      "flex cursor-pointer items-start gap-2 rounded-md border p-2 text-xs transition-colors hover:bg-muted/40",
                      checked && "border-primary/40 bg-primary/5"
                    )}
                  >
                    <Checkbox
                      id={inputId}
                      checked={checked}
                      onCheckedChange={(value) => toggleSection(section.id, value === true)}
                      className="mt-0.5"
                    />
                    <span className="min-w-0 flex-1 space-y-0.5">
                      <span className="flex items-center gap-1.5 font-medium">
                        {sectionText(section.labelKey, section.id)}
                        {section.sensitive && (
                          <Badge
                            variant="outline"
                            className="h-4 gap-1 px-1 text-[10px] font-normal text-muted-foreground"
                          >
                            <ShieldCheckIcon className="size-2.5" aria-hidden="true" />
                            {t("redacted")}
                          </Badge>
                        )}
                      </span>
                      <span className="block text-muted-foreground">
                        {sectionText(section.descriptionKey, "")}
                      </span>
                    </span>
                  </label>
                </li>
              )
            })}
          </ul>
        )}
      </fieldset>

      <Collapsible open={previewOpen} onOpenChange={setPreviewOpen}>
        <CollapsibleTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="group -ml-2 h-7 gap-1.5 px-2 text-xs text-muted-foreground"
          >
            <ChevronDownIcon
              className="size-3.5 transition-transform group-data-[state=open]:rotate-180"
              aria-hidden="true"
            />
            {previewOpen ? t("hidePreview") : t("preview")}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-1.5">
          {previewFailed ? (
            <p role="alert" className="text-xs text-destructive">
              {t("previewFailed")}
            </p>
          ) : preview ? (
            <pre
              className="max-h-56 overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap"
              data-testid="report-problem-preview"
            >
              {preview}
            </pre>
          ) : (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Spinner className="size-3.5" />
              {t("building")}
            </div>
          )}
        </CollapsibleContent>
      </Collapsible>

      <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
        <ShieldCheckIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        {t("privacyNote")}
      </p>

      <DialogFooter className="gap-2">
        <div className="flex flex-wrap justify-end gap-2" data-testid="report-problem-channels">
          {channels.map((channel) => {
            const Icon = CHANNEL_ICONS[channel.id] ?? SendIcon
            const busy = busyChannel === channel.id
            return (
              <Button
                key={channel.id}
                type="button"
                size="sm"
                variant={channel.primary ? "default" : "outline"}
                disabled={busyChannel !== null}
                onClick={() => void deliver(channel.id)}
                data-testid={`report-problem-channel-${channel.id}`}
              >
                {busy ? (
                  <Spinner className="size-3.5" />
                ) : (
                  <Icon className="size-3.5" aria-hidden="true" />
                )}
                {channelLabel(channel.id)}
              </Button>
            )
          })}
        </div>
      </DialogFooter>
    </div>
  )
}
