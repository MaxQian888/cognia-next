"use client"

// Engine switch shared by every project-editor host (Agent Team workspace tab,
// chat-side workspace dock). Both render the same Monaco workbench and the same
// CodeServerPane, so the control that picks between them lives here rather than
// being copy-pasted per host.

import { useEffect, useId, useState } from "react"
import { useTranslations } from "next-intl"
import {
  CodeIcon,
  ExternalLinkIcon,
  InfoIcon,
  PuzzleIcon,
  ShieldCheckIcon,
  SquareCodeIcon,
} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { type CodeServerProfile, codeServerClient } from "@/lib/codeserver/client"
import type { CodeServerSupportStatus } from "@/hooks/codeserver/use-code-server-supported"
import { useRemoteHostActive } from "@/hooks/use-host-profile"
import { isTauri } from "@/lib/tauri"
import { cn } from "@/lib/utils"

export type ProjectEditorEngine = "monaco" | "codeserver"

interface Props {
  value: ProjectEditorEngine
  onChange: (next: ProjectEditorEngine) => void
  /**
   * False when this host has no prebuilt code-server binary (Windows / exotic
   * arch) — the Pro IDE option is disabled with an explanatory tooltip.
   */
  proIdeSupport: CodeServerSupportStatus
  /** Absolute project root, opened by the local-VS-Code fallback. */
  projectRoot: string
  /**
   * Which code-server trust domain the Pro IDE pane runs in. Only meaningful
   * while `value === "codeserver"`; the selector is hidden otherwise.
   */
  proIdeProfile?: CodeServerProfile
  /**
   * Omit to hide the profile selector entirely — for hosts that deliberately
   * pin the managed profile (agent drive and the plugin IDE capabilities only
   * exist there).
   */
  onProIdeProfileChange?: (next: CodeServerProfile) => void
  className?: string
}

export function EditorEngineToggle({
  value,
  onChange,
  proIdeSupport,
  projectRoot,
  proIdeProfile = "managed",
  onProIdeProfileChange,
  className,
}: Props) {
  const t = useTranslations("projectEditor")

  // Where the embedded Pro IDE has no build, the disabled toggle used to point
  // at "your local VS Code" with no way to get there. Offer the real action
  // when a `code` launcher actually exists.
  const [localVsCode, setLocalVsCode] = useState(false)
  useEffect(() => {
    if (!isTauri() || proIdeSupport !== "unsupported") return
    let alive = true
    void codeServerClient
      .localVsCodeAvailable()
      .then((ok) => {
        if (alive) setLocalVsCode(ok)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [proIdeSupport])

  const proIdeSupported = proIdeSupport === "supported"
  const disabledTooltipId = useId()
  const disabledTooltip =
    proIdeSupport === "error"
      ? t("proIde.supportCheckFailed")
      : proIdeSupport === "checking"
        ? t("proIde.checkingTooltip")
        : t("proIde.disabledTooltip")

  const openLocal = () =>
    void codeServerClient
      .openInLocalVsCode(projectRoot)
      .catch((cause) => toast.error(t("proIde.localVsCodeFailed", { error: String(cause) })))

  // Driving a remote host means the workbench on screen belongs to that host.
  // The app-to-editor direction reaches it now, but the reverse does not: the
  // extension reports editor changes as host-process events, and no request
  // carries an event back. `CodeServerPane` keeps those two consumers gated.
  // This is where the user is told, next to the switch that put them here.
  const remoteWorkbench = useRemoteHostActive() && value === "codeserver" && proIdeSupported

  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      <ToggleGroup
        type="single"
        value={value}
        // Radix allows deselecting the active item, which would leave the host
        // with no engine at all — ignore the empty value instead.
        onValueChange={(next) => {
          if (next) onChange(next as ProjectEditorEngine)
        }}
        variant="outline"
        size="sm"
        aria-label={t("proIde.switchLabel")}
        className="h-7"
      >
        <ToggleGroupItem
          value="monaco"
          data-testid="editor-mode-monaco"
          aria-label={t("proIde.toggleMonaco")}
          className="gap-1 px-2 text-xs"
        >
          <CodeIcon className="size-3.5" />
          {t("proIde.toggleMonaco")}
        </ToggleGroupItem>
        {proIdeSupported ? (
          <ToggleGroupItem
            value="codeserver"
            data-testid="editor-mode-codeserver"
            aria-label={t("proIde.toggleVsCode")}
            className="gap-1 px-2 text-xs"
          >
            <SquareCodeIcon className="size-3.5" />
            {t("proIde.toggleVsCode")}
          </ToggleGroupItem>
        ) : (
          // A `disabled` button dispatches no mouse events, so the native
          // `title` tooltip this used to carry never appeared — on Windows and
          // other unsupported platforms the option was simply greyed out with
          // no way to find out why. Radix needs a non-disabled element to hang
          // the trigger on, hence the wrapping span; `aria-describedby` ties the
          // reason to the control for screen readers, which `title` on a
          // disabled control also failed to do.
          // Self-provided rather than relying on the app-shell provider: this
          // control ships in two hosts and several test harnesses, and a
          // missing ancestor provider is a hard crash, not a degraded tooltip.
          // Radix nests providers without complaint.
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex" data-testid="editor-mode-codeserver-disabled">
                  <ToggleGroupItem
                    value="codeserver"
                    data-testid="editor-mode-codeserver"
                    aria-label={t("proIde.toggleVsCode")}
                    aria-describedby={disabledTooltipId}
                    disabled
                    className="gap-1 px-2 text-xs"
                  >
                    <SquareCodeIcon className="size-3.5" />
                    {t("proIde.toggleVsCode")}
                  </ToggleGroupItem>
                </span>
              </TooltipTrigger>
              <TooltipContent id={disabledTooltipId}>{disabledTooltip}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </ToggleGroup>

      {/* An icon chip rather than a paragraph: this row is a tight strip of
          controls, and a banner here would push the editor down every time the
          user drives a remote host. The tooltip carries the whole explanation. */}
      {remoteWorkbench ? (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className="inline-flex h-7 items-center gap-1 rounded-pill border border-warning/40 bg-warning/10 px-2 text-xs text-muted-foreground"
                data-testid="pro-ide-remote-workbench"
              >
                <InfoIcon className="size-3.5 shrink-0 text-warning" aria-hidden />
                {t("proIde.remoteWorkbenchLabel")}
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-sm">
              {t("proIde.remoteWorkbenchTooltip")}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : null}

      {/* The two profiles are separate processes with separate extension and
          user-data directories, and only the managed one holds Cognia broker
          credentials — so this is a trust-domain switch, not a preference.
          Rendered next to the engine switch because it answers the same
          question ("which editor am I looking at"), and only while Pro IDE is
          the live engine: it means nothing to Monaco. */}
      {value === "codeserver" && proIdeSupported && onProIdeProfileChange ? (
        <TooltipProvider>
          <ToggleGroup
            type="single"
            value={proIdeProfile}
            onValueChange={(next) => {
              if (!next || next === proIdeProfile) return
              // The consequence is worth stating at the moment it happens
              // rather than in a tooltip nobody opens: the two profiles are
              // separate processes with separate user-data and extension
              // directories, so switching does not reconfigure the workbench,
              // it replaces it and leaves the open editors and terminals
              // behind in the other one.
              toast.info(t("proIde.profileSwitchRestarts"))
              onProIdeProfileChange(next as CodeServerProfile)
            }}
            variant="outline"
            size="sm"
            aria-label={t("proIde.profileLabel")}
            className="h-7"
            data-testid="pro-ide-profile-toggle"
          >
            {/* The trigger hangs on a wrapping span rather than on the item
                itself: `asChild` merges the tooltip's own `data-state`
                (open/closed) onto its child, which would overwrite the
                ToggleGroupItem's on/off state — the attribute Radix styles the
                selected profile from. Same reason the disabled engine item
                above wraps. */}
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex">
                  <ToggleGroupItem
                    value="managed"
                    data-testid="pro-ide-profile-managed"
                    aria-label={t("proIde.profileManaged")}
                    className="gap-1 px-2 text-xs"
                  >
                    <ShieldCheckIcon className="size-3.5" />
                    {t("proIde.profileManaged")}
                  </ToggleGroupItem>
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                {t("proIde.profileManagedTooltip")}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex">
                  <ToggleGroupItem
                    value="native"
                    data-testid="pro-ide-profile-native"
                    aria-label={t("proIde.profileNative")}
                    className="gap-1 px-2 text-xs"
                  >
                    <PuzzleIcon className="size-3.5" />
                    {t("proIde.profileNative")}
                  </ToggleGroupItem>
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                {t("proIde.profileNativeTooltip")}
              </TooltipContent>
            </Tooltip>
          </ToggleGroup>
        </TooltipProvider>
      ) : null}

      {proIdeSupport === "unsupported" && localVsCode ? (
        <Button
          size="sm"
          variant="ghost"
          className="h-7 gap-1 px-2 text-xs"
          onClick={openLocal}
          data-testid="editor-open-local-vscode"
        >
          <ExternalLinkIcon className="size-3.5" />
          {t("proIde.openLocalVsCode")}
        </Button>
      ) : null}
    </div>
  )
}
