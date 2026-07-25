"use client"

// Engine switch shared by every project-editor host (Agent Team workspace tab,
// chat-side workspace dock). Both render the same Monaco workbench and the same
// CodeServerPane, so the control that picks between them lives here rather than
// being copy-pasted per host.

import { useEffect, useId, useState } from "react"
import { useTranslations } from "next-intl"
import { CodeIcon, ExternalLinkIcon, SquareCodeIcon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { codeServerClient } from "@/lib/codeserver/client"
import type { CodeServerSupportStatus } from "@/hooks/codeserver/use-code-server-supported"
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
  className?: string
}

export function EditorEngineToggle({
  value,
  onChange,
  proIdeSupport,
  projectRoot,
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
