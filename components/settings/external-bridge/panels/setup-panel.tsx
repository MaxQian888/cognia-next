"use client"

/**
 * Settings → External Bridge → Client setup.
 *
 * Renders a paste-ready MCP client config for Claude Desktop (stdio + HTTP),
 * Cursor and Goose.
 *
 * The stdio variant used to print a literal `/path/to/cognia-mcp.js`, so the
 * one variant that needs no token was also the one the user could not paste
 * without editing. It is now resolved through the same Rust resolver the spawn
 * path uses — including the case where the sidecar is not installed, which the
 * panel says out loud rather than papering over with a plausible-looking path.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { CopyIcon } from "lucide-react"
import { toast } from "sonner"

import { PanelTransition } from "@/components/settings/common/panel-transition"
import { SettingsCard } from "@/components/settings/common/settings-section"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { ExternalBridgeSettings } from "@/types/wiki"

import { DEFAULT_BRIDGE_HTTP_PORT, resolveSidecarPath } from "../bridge-runtime"

type SetupVariant = "claude-desktop-stdio" | "claude-desktop-http" | "cursor" | "goose"

const SETUP_VARIANTS: SetupVariant[] = [
  "claude-desktop-stdio",
  "claude-desktop-http",
  "cursor",
  "goose",
]

export interface BridgeSetupPanelProps {
  settings: ExternalBridgeSettings
}

type SidecarResolution =
  { state: "loading" } | { state: "ready"; path: string } | { state: "missing" }

export function BridgeSetupPanel({ settings }: BridgeSetupPanelProps) {
  const t = useTranslations("settings.externalBridge")
  const [variant, setVariant] = useState<SetupVariant>("claude-desktop-stdio")
  // Tri-state on purpose: "still resolving" and "not installed" are different
  // answers, and collapsing them hid the second one behind a spinner forever.
  const [sidecar, setSidecar] = useState<SidecarResolution>({ state: "loading" })

  useEffect(() => {
    let cancelled = false
    resolveSidecarPath()
      .then((path) => {
        if (cancelled) return
        setSidecar(path ? { state: "ready", path } : { state: "missing" })
      })
      .catch(() => {
        if (!cancelled) setSidecar({ state: "missing" })
      })
    return () => {
      cancelled = true
    }
  }, [])

  const snippet = useMemo(() => {
    const port = settings.httpPort ?? DEFAULT_BRIDGE_HTTP_PORT
    const token = settings.bearerToken ?? t("setup.tokenPlaceholder")
    const command =
      sidecar.state === "ready"
        ? sidecar.path
        : sidecar.state === "loading"
          ? t("setup.sidecarResolving")
          : t("setup.sidecarMissingPlaceholder")

    switch (variant) {
      case "claude-desktop-stdio":
        return JSON.stringify(
          { mcpServers: { cognia: { command: "node", args: [command] } } },
          null,
          2
        )
      case "claude-desktop-http":
        return JSON.stringify(
          {
            mcpServers: {
              cognia: {
                transport: "http",
                url: `http://127.0.0.1:${port}/mcp`,
                headers: { Authorization: `Bearer ${token}` },
              },
            },
          },
          null,
          2
        )
      case "cursor":
        // Cursor's mcp.json mirrors Claude Desktop's mcpServers but lives at
        // ~/.cursor/mcp.json (or .cursor/mcp.json in-project). The shape is
        // identical to Claude Desktop's HTTP form when targeting our bridge.
        return JSON.stringify(
          {
            mcpServers: {
              cognia: {
                url: `http://127.0.0.1:${port}/mcp`,
                headers: { Authorization: `Bearer ${token}` },
              },
            },
          },
          null,
          2
        )
      case "goose":
        // Goose uses YAML under ~/.config/goose/config.yaml. Single MCP entry
        // tied to the HTTP transport so the operator doesn't have to install
        // a sidecar wrapper script.
        return [
          "extensions:",
          "  cognia:",
          "    type: streamable_http",
          `    uri: http://127.0.0.1:${port}/mcp`,
          "    headers:",
          `      Authorization: "Bearer ${token}"`,
        ].join("\n")
    }
  }, [variant, settings.httpPort, settings.bearerToken, sidecar, t])

  const onCopy = useCallback(async () => {
    await navigator.clipboard.writeText(snippet)
    toast.success(t("setup.toastCopied"))
  }, [snippet, t])

  return (
    <div className="space-y-4">
      <SettingsCard title={t("setup.title")} description={t("setup.description")}>
        <div className="flex flex-col gap-2 @lg/bridge-pane:flex-row @lg/bridge-pane:items-center">
          <Select value={variant} onValueChange={(v) => setVariant(v as SetupVariant)}>
            <SelectTrigger
              className="w-full @lg/bridge-pane:w-[260px]"
              aria-label={t("setup.clientLabel")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SETUP_VARIANTS.map((v) => (
                <SelectItem key={v} value={v}>
                  {t(`setup.variants.${v}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void onCopy()}
            className="@lg/bridge-pane:ml-auto"
            aria-label={t("setup.copyAria")}
          >
            <CopyIcon className="h-3.5 w-3.5" /> {t("setup.copy")}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t(`setup.variantHelp.${variant}`)}</p>
        {variant === "claude-desktop-stdio" && sidecar.state === "missing" ? (
          <p
            className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-xs text-amber-700 dark:text-amber-400"
            data-testid="bridge-sidecar-missing"
          >
            {t("setup.sidecarMissing")}
          </p>
        ) : null}
        <PanelTransition activeKey={variant}>
          <pre
            className="overflow-x-auto rounded bg-muted p-3 text-xs"
            data-testid="bridge-setup-snippet"
          >
            <code>{snippet}</code>
          </pre>
        </PanelTransition>
      </SettingsCard>
    </div>
  )
}
