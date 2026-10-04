"use client"

/**
 * Step two of adding an external agent on the phone: review and add it to the
 * paired Host.
 *
 * The agent is created on the Host, not on the phone. A phone has no process
 * table, so an agent configured in its own store could never run; the old
 * flow wrote one there anyway and left the user to find "copy to host" in a
 * different settings panel.
 *
 * What most people touch — the name and how much the agent may do unasked —
 * is on the page. Every technical field (protocol, transport, command,
 * environment, retries, model binding) is the same set the desktop dialog
 * shows, folded into "Advanced settings". A custom agent opens with that
 * section expanded, since it has nothing to fill in otherwise; a preset opens
 * with it closed, and it opens itself when a problem can only be fixed there.
 */

import { useRef, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { AlertCircleIcon, ChevronDownIcon, ServerIcon, ServerCogIcon } from "lucide-react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { BrandIcon } from "@/components/icons/brand-icon"
import { ConnectionFields } from "@/components/agent/external-agent/add-agent/connection-fields"
import {
  AddAgentCogniaModelField,
  ExecutionTuningFields,
} from "@/components/agent/external-agent/add-agent/execution-tuning-fields"
import {
  PLANE_WARNING_KEYS,
  PresetGuidance,
} from "@/components/agent/external-agent/add-agent/preset-guidance"
import {
  presetDescription,
  presetName,
} from "@/components/agent/external-agent/add-agent/preset-copy"
import { useAddAgentForm } from "@/hooks/agent/use-add-agent-form"
import { useAddAgentProblemMessage } from "@/hooks/agent/use-add-agent-problem-message"
import { useExternalAgentProcessPlane } from "@/hooks/agent/use-external-agent-process-plane"
import { useHostExternalAgentConfigs } from "@/hooks/agent/use-host-external-agent-configs"
import { useInstalledAgentRuntimes } from "@/hooks/agent/use-installed-agent-runtimes"
import { PROCESS_PLANE_COMMANDS } from "@/lib/ai/agent/external/capability/process-plane"
import {
  CONNECTION_PROBLEMS,
  buildCreateExternalAgentInput,
} from "@/lib/ai/agent/external/config/add-agent-form"
import { getPresetConfig } from "@/lib/ai/agent/external/config/presets"
import type { HostConfigsUnavailableReason } from "@/lib/ai/agent/external/runtimes/remote/remote-host-configs"
import type { StoredExternalAgentConfig } from "@/stores/agent/external-agent-store/types"
import type { AcpPermissionMode } from "@/types/agent/external-agent"

import {
  PERMISSION_MODE_LABEL_KEY,
  effectivePermissionMode,
  permissionModesFor,
} from "./permission-modes"
import { ADD_EXTERNAL_AGENT_ROUTE, EXTERNAL_AGENTS_ROUTE } from "./routes"

/** `externalAgent.hostConfigs` key for each reason the Host cannot take an agent. */
export const HOST_UNAVAILABLE_KEY: Record<HostConfigsUnavailableReason, string> = {
  "no-host": "unavailableNoHost",
  unsupported: "unavailableUnsupported",
  "manifest-missing": "unavailableManifestMissing",
}

export interface AddExternalAgentFormProps {
  /** A runnable preset id, or `"custom"` for a blank configuration. */
  presetId: string
}

export function AddExternalAgentForm({ presetId }: AddExternalAgentFormProps) {
  if (presetId !== "custom" && !getPresetConfig(presetId)) {
    return <UnknownPreset />
  }
  // Keyed so switching presets in place starts a fresh form rather than
  // carrying one preset's command into another's fields.
  return <AddExternalAgentFormBody key={presetId} presetId={presetId} />
}

function UnknownPreset() {
  const t = useTranslations("mobile.externalAgents")
  return (
    <Empty className="flex-1" data-testid="add-agent-unknown-preset">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <AlertCircleIcon />
        </EmptyMedia>
        <EmptyDescription>{t("unknownPreset")}</EmptyDescription>
      </EmptyHeader>
      <Button asChild variant="outline">
        <Link href={ADD_EXTERNAL_AGENT_ROUTE}>{t("pickTitle")}</Link>
      </Button>
    </Empty>
  )
}

function AddExternalAgentFormBody({ presetId }: { presetId: string }) {
  const t = useTranslations("mobile.externalAgents")
  const tSettings = useTranslations("externalAgent.settings")
  const tManager = useTranslations("externalAgent.manager")
  const tHost = useTranslations("externalAgent.hostConfigs")
  const router = useRouter()
  const host = useHostExternalAgentConfigs()
  const form = useAddAgentForm(presetId)
  const problemMessage = useAddAgentProblemMessage()
  const detection = useInstalledAgentRuntimes(true)
  const processPlane = useExternalAgentProcessPlane(PROCESS_PLANE_COMMANDS.spawn)
  const planeWarning = processPlane.ok
    ? null
    : tManager(`processPlaneWarning.${PLANE_WARNING_KEYS[processPlane.reason]}`)

  const preset = form.shape.preset
  const [requestedMode, setRequestedMode] = useState<AcpPermissionMode | undefined>(
    preset?.defaultPermissionMode
  )
  const permissionMode = effectivePermissionMode(requestedMode, form.data.protocol)
  const [advancedOpen, setAdvancedOpen] = useState(presetId === "custom")
  const [problem, setProblem] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const advancedRef = useRef<HTMLDivElement>(null)

  const displayName = preset ? presetName(tSettings, presetId, preset) : t("configureCustomTitle")

  if (host.unavailable) {
    return (
      <Empty className="flex-1" data-testid="add-agent-host-unavailable">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ServerCogIcon />
          </EmptyMedia>
          <EmptyTitle>{tHost("unavailableTitle")}</EmptyTitle>
          <EmptyDescription>{tHost(HOST_UNAVAILABLE_KEY[host.unavailable])}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (submitting) return
    const prepared = form.prepare()
    if (!prepared.ok) {
      setProblem(problemMessage(prepared.problem))
      if (CONNECTION_PROBLEMS.has(prepared.problem)) {
        setAdvancedOpen(true)
        // After the section has rendered open, so there is something to reach.
        requestAnimationFrame(() =>
          advancedRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
        )
      }
      return
    }
    setProblem(null)
    setSubmitting(true)
    const input = buildCreateExternalAgentInput(prepared.data, {
      defaultPermissionMode: permissionMode,
    })
    const created = await host.create({
      ...(input as Partial<StoredExternalAgentConfig>),
      enabled: true,
    })
    setSubmitting(false)
    if (!created.ok) {
      // Shown where the user is looking, and toasted in case they scrolled.
      const message = t("createFailed", { message: created.error })
      setProblem(message)
      toast.error(message)
      return
    }
    toast.success(t("added", { name: prepared.data.name }))
    router.replace(EXTERNAL_AGENTS_ROUTE)
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-1 flex-col gap-5"
      noValidate
      data-testid="add-external-agent-form"
    >
      <div className="flex items-start gap-3 rounded-xl border bg-card p-3">
        {preset ? (
          <BrandIcon id={presetId} size={40} label={displayName} />
        ) : (
          <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-md bg-muted">
            <ServerCogIcon className="size-5" aria-hidden />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-base font-semibold">{displayName}</p>
          {preset ? (
            <p className="line-clamp-2 text-xs text-muted-foreground">
              {presetDescription(tSettings, presetId, preset)}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">{t("customDescription")}</p>
          )}
          <p className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
            <ServerIcon className="size-3" aria-hidden />
            {t("runsOnHost")}
          </p>
        </div>
      </div>

      {preset ? <PresetGuidance presetId={presetId} preset={preset} detection={detection} /> : null}

      <div className="grid gap-4">
        <div className="grid gap-2">
          <Label htmlFor="name">{tManager("name")}</Label>
          <Input
            id="name"
            value={form.data.name}
            onChange={(event) => form.setField("name", event.target.value)}
            // i18n-exempt: example agent name (brand), not UI prose
            placeholder="Claude Code"
            className="h-10"
            required
            data-testid="add-agent-name"
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="permission-mode">{t("permissionLabel")}</Label>
          <Select
            value={permissionMode}
            onValueChange={(value) => setRequestedMode(value as AcpPermissionMode)}
          >
            <SelectTrigger
              id="permission-mode"
              className="h-10 w-full"
              data-testid="add-agent-permission"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {permissionModesFor(form.data.protocol).map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {t(PERMISSION_MODE_LABEL_KEY[mode])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{t("permissionHint")}</p>
        </div>
      </div>

      <Collapsible
        open={advancedOpen}
        onOpenChange={setAdvancedOpen}
        className="rounded-xl border"
        data-testid="add-agent-advanced"
      >
        <div ref={advancedRef} className="scroll-mt-16">
          <CollapsibleTrigger
            className="group flex w-full items-center justify-between gap-3 px-3 py-3 text-left"
            data-testid="add-agent-advanced-trigger"
          >
            <span className="min-w-0">
              <span className="block text-sm font-medium">{t("advancedTitle")}</span>
              <span className="block text-xs text-muted-foreground">{t("advancedSummary")}</span>
            </span>
            <ChevronDownIcon
              className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180"
              aria-hidden
            />
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent className="grid gap-5 border-t px-3 py-4">
          <ConnectionFields form={form} planeWarning={planeWarning} />
          <ExecutionTuningFields form={form} collapsible={false} />
          <AddAgentCogniaModelField form={form} />
        </CollapsibleContent>
      </Collapsible>

      {problem ? (
        <Alert variant="destructive" data-testid="add-agent-problem">
          <AlertCircleIcon />
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      ) : null}

      {/* Sticky inside the page's own scroller, so it rides above the keyboard
          instead of a fixed footer sitting on top of the field being typed in. */}
      <div className="sticky bottom-0 -mx-4 mt-auto border-t bg-background/95 px-4 pt-3 pb-3 safe-area-pb backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <Button
          type="submit"
          className="h-11 w-full"
          disabled={submitting || host.loading}
          data-testid="add-agent-submit"
        >
          {submitting ? (
            <>
              <Spinner className="size-4" />
              {t("submitting")}
            </>
          ) : (
            t("submit")
          )}
        </Button>
      </div>
    </form>
  )
}
