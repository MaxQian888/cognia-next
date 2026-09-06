"use client"

/**
 * How to install a third-party networking client on this machine.
 *
 * Shared by the Connectivity tunnel block, the Connections tunnel tab and
 * the overlay-network block, so `cloudflared`, Tailscale and ZeroTier are
 * explained the same way in every place that needs one. The steps come from
 * `lib/connectivity/tunnel-install.ts` and are shown for the OS this webview
 * runs on, which on the desktop is the Host machine. A companion shell never
 * renders this: the binary has to be on the Host, and the block that would
 * show it is already blocked with a reason there.
 */

import { useCallback, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { CopyIcon, DownloadIcon, ExternalLinkIcon, RefreshCwIcon } from "lucide-react"
import { toast } from "sonner"

import { Surface } from "@/components/surface/surface"
import { Button } from "@/components/ui/button"
import {
  installSteps,
  type InstallableTool,
  type InstallStep,
} from "@/lib/connectivity/tunnel-install"
import { detectDesktopOsFamily, type DesktopOsFamily } from "@/lib/platform/os"
import { openExternal } from "@/lib/tauri/opener"
import { cn } from "@/lib/utils"

export interface TunnelInstallGuideProps {
  tool: InstallableTool
  /** Defaults to the OS this webview runs on. */
  os?: DesktopOsFamily
  /** Re-run the probe that found the tool missing. Renders the button when set. */
  onRecheck?: () => void | Promise<void>
  rechecking?: boolean
  className?: string
  testid?: string
  /** Test seams. */
  copy?: (text: string) => Promise<void>
  open?: (url: string) => Promise<void>
}

const defaultCopy = async (text: string) => {
  await navigator.clipboard.writeText(text)
}

export function TunnelInstallGuide({
  tool,
  os,
  onRecheck,
  rechecking = false,
  className,
  testid = "tunnel-install-guide",
  copy = defaultCopy,
  open = openExternal,
}: TunnelInstallGuideProps) {
  const t = useTranslations("settings.connectivity.tunnelInstall")
  const [detected] = useState<DesktopOsFamily>(() => os ?? detectDesktopOsFamily())
  const family = os ?? detected
  const steps = useMemo(() => installSteps(tool, family), [tool, family])
  const toolName = t(`tool.${tool}`)

  const onCopy = useCallback(
    async (step: InstallStep) => {
      if (!step.command) return
      try {
        await copy(step.command)
        toast.success(t("copied"))
      } catch {
        toast.error(t("copyFailed"))
      }
    },
    [copy, t]
  )

  return (
    <Surface asChild layer="base" radius="control">
      <div
        role="region"
        aria-label={t("title", { tool: toolName })}
        data-testid={testid}
        data-tool={tool}
        data-os={family}
        className={cn("space-y-2 border border-border/60 px-3 py-2.5", className)}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-xs font-medium">{t("title", { tool: toolName })}</p>
            <p className="text-[11px] text-muted-foreground">
              {family === "unknown"
                ? t("description")
                : t("descriptionOs", { os: t(`os.${family}`) })}
            </p>
          </div>
          {onRecheck ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void onRecheck()}
              disabled={rechecking}
              data-testid={`${testid}-recheck`}
            >
              <RefreshCwIcon
                className={cn("mr-1 size-3.5", rechecking && "animate-spin")}
                aria-hidden="true"
              />
              {rechecking ? t("checking") : t("recheck")}
            </Button>
          ) : null}
        </div>
        <ul className="space-y-1.5">
          {steps.map((step, index) => {
            const via =
              step.via === "download" ? t("via.download", { tool: toolName }) : t(`via.${step.via}`)
            return (
              <li
                key={`${step.via}-${index}`}
                className="flex items-center gap-2"
                data-testid={`${testid}-step-${step.via}`}
              >
                {step.command ? (
                  <>
                    <code className="min-w-0 flex-1 truncate rounded border bg-background px-2 py-1 text-[11px]">
                      {step.command}
                    </code>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void onCopy(step)}
                      aria-label={t("copy", { via })}
                      data-testid={`${testid}-copy-${step.via}`}
                    >
                      <CopyIcon className="size-3.5" aria-hidden="true" />
                    </Button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void open(step.url ?? "")}
                    data-testid={`${testid}-open-${step.via}`}
                  >
                    {step.via === "appStore" ? (
                      <ExternalLinkIcon className="mr-1 size-3.5" aria-hidden="true" />
                    ) : (
                      <DownloadIcon className="mr-1 size-3.5" aria-hidden="true" />
                    )}
                    {via}
                  </Button>
                )}
              </li>
            )
          })}
        </ul>
      </div>
    </Surface>
  )
}
