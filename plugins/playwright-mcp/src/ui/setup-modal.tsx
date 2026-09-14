"use client"

/**
 * `/browser` setup guide — the modal the plugin's slash command opens.
 *
 * Lists every way to wire a Playwright MCP server (the two static catalog
 * presets plus the two this plugin contributes), what each one requires, and
 * deep-links straight to the matching gallery card via the MCP panel's
 * `?preset=` param. The environment check runs `node --version` /
 * `npx --version` through the plugin's allowlisted `ctx.shell` — the single
 * failure mode every preset shares is a missing Node.js toolchain, so the
 * guide surfaces it instead of leaving users with a server that never
 * connects.
 *
 * The host wraps the component in `Dialog`/`DialogContent`
 * (`plugin-modal-root.tsx`), so `DialogTitle`/`DialogDescription` here pick
 * up the Radix context for aria labelling; the close X is the shell's.
 */

import { useState } from "react"
import { useRouter } from "next/navigation"
import type { PluginModalProps } from "@cognia/plugin-sdk"
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  cn,
} from "@cognia/plugin-ui"
import { getPluginShell } from "../runtime"
import { usePluginT } from "./use-plugin-t"

interface ModeRow {
  /** Catalog id the CTA deep-links to — matches a gallery card one-for-one. */
  presetId: string
  /** Gallery name — kept English so it matches what the CTA lands on. */
  title: string
  icon: string
  descKey: string
  reqKeys: string[]
  safetyKey?: string
}

const MODES: ModeRow[] = [
  {
    presetId: "playwright",
    title: "Playwright",
    icon: "🎭",
    descKey: "mode.playwright.desc",
    reqKeys: ["req.node"],
  },
  {
    presetId: "playwright-isolated",
    title: "Playwright — Isolated",
    icon: "🎬",
    descKey: "mode.isolated.desc",
    reqKeys: ["req.node", "req.disposable"],
  },
  {
    presetId: "playwright-existing-browser",
    title: "Playwright — Existing Browser",
    icon: "🌐",
    descKey: "mode.existing.desc",
    reqKeys: ["req.node", "req.extension", "req.approval"],
    safetyKey: "mode.existing.safety",
  },
  {
    presetId: "playwright-cdp",
    title: "Playwright — Attach over CDP",
    icon: "🖥️",
    descKey: "mode.cdp.desc",
    reqKeys: ["req.node", "req.cdpPort"],
  },
]

type EnvState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "ready"; node: string; npx: string }
  | { status: "missing" }
  | { status: "unavailable" }
  | { status: "error" }

const DOCS_URL = "https://github.com/microsoft/playwright-mcp"

export function PlaywrightSetupModal({ onClose, args }: PluginModalProps) {
  const t = usePluginT()
  const router = useRouter()
  const focus = typeof args?.focus === "string" ? args.focus : undefined
  const shell = getPluginShell()
  const [env, setEnv] = useState<EnvState>({ status: "idle" })

  const runEnvCheck = async (): Promise<void> => {
    if (!shell?.execute) {
      setEnv({ status: "unavailable" })
      return
    }
    setEnv({ status: "running" })
    try {
      const [node, npx] = await Promise.all([
        shell.execute("node", { args: ["--version"] }),
        shell.execute("npx", { args: ["--version"] }),
      ])
      if (node.success && npx.success) {
        setEnv({ status: "ready", node: node.stdout.trim(), npx: npx.stdout.trim() })
      } else {
        setEnv({ status: "missing" })
      }
    } catch {
      // Consent denied or the allowlist rejected the command — the check
      // itself failed, which says nothing about whether Node exists.
      setEnv({ status: "error" })
    }
  }

  const openInSettings = (presetId: string): void => {
    onClose()
    // The `?preset=` param is the MCP panel's own contract: mcp-panel.tsx
    // reads `pendingPreset` and forwards it to McpPresetGrid, which selects
    // the card in the merged (static ⊕ plugin) catalog. Plugins cannot import
    // the host's `mcpHref` builder, so the route is spelled out here and
    // pinned by the modal test.
    router.push(`/settings?section=mcp&preset=${encodeURIComponent(presetId)}`)
  }

  return (
    <div className="flex flex-col gap-4" data-testid="playwright-setup-modal">
      <DialogHeader>
        <DialogTitle>{t("modal.title")}</DialogTitle>
        <DialogDescription>{t("modal.subtitle")}</DialogDescription>
      </DialogHeader>

      <section
        className="rounded-md border border-dashed p-3"
        aria-label={t("modal.env.label")}
        data-testid="env-check"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium">{t("modal.env.label")}</span>
          {shell?.execute ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void runEnvCheck()}
              disabled={env.status === "running"}
              data-testid="env-check-run"
            >
              {env.status === "running" ? t("modal.env.checking") : t("modal.env.check")}
            </Button>
          ) : null}
        </div>
        <p
          className={cn(
            "mt-2 text-xs",
            env.status === "ready" && "text-emerald-600 dark:text-emerald-400",
            (env.status === "missing" || env.status === "error") && "text-destructive",
            (env.status === "idle" || env.status === "unavailable" || env.status === "running") &&
              "text-muted-foreground"
          )}
        >
          {env.status === "ready"
            ? t("modal.env.ready", { node: env.node, npx: env.npx })
            : env.status === "missing"
              ? t("modal.env.missing")
              : env.status === "unavailable" || !shell?.execute
                ? t("modal.env.unavailable")
                : env.status === "error"
                  ? t("modal.env.error")
                  : t("modal.env.hint")}
        </p>
      </section>

      <ul className="flex flex-col gap-2">
        {MODES.map((mode) => (
          <li
            key={mode.presetId}
            className={cn(
              "rounded-lg border p-3",
              focus === mode.presetId && "border-primary bg-accent/30"
            )}
            data-testid={`mode-${mode.presetId}`}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span aria-hidden>{mode.icon}</span>
                <span className="text-sm font-medium">{mode.title}</span>
              </div>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => openInSettings(mode.presetId)}
                data-testid={`setup-${mode.presetId}`}
              >
                {t("modal.setUp")}
              </Button>
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">{t(mode.descKey)}</p>
            <div className="mt-2 flex flex-wrap gap-1">
              {mode.reqKeys.map((key) => (
                <Badge key={key} variant="outline" className="text-[10px] font-normal">
                  {t(key)}
                </Badge>
              ))}
            </div>
            {mode.safetyKey ? (
              <p className="mt-2 text-[11px] text-muted-foreground/80">{t(mode.safetyKey)}</p>
            ) : null}
          </li>
        ))}
      </ul>

      <Alert>
        <AlertDescription className="text-xs">{t("modal.afterAdd")}</AlertDescription>
      </Alert>

      <DialogFooter
        closeLabel={t("modal.close")}
        className="items-center justify-between sm:justify-between"
      >
        <a
          href={DOCS_URL}
          target="_blank"
          rel="noreferrer noopener"
          className="text-xs text-muted-foreground underline-offset-4 hover:underline"
        >
          {t("modal.docs")}
        </a>
        <Button variant="outline" size="sm" onClick={onClose}>
          {t("modal.close")}
        </Button>
      </DialogFooter>
    </div>
  )
}
