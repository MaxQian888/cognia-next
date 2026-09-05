"use client"

/**
 * How to mint an invitation, for the browser flow.
 *
 * Lives in the narrative panel rather than beside the field. It is invariant
 * material — the same three commands whatever state the pairing is in — and
 * putting it in the form's column is what made the web page a tall single
 * stack: the command block, the field, the decoded summary, the storage notice
 * and the error panel all competing for one column.
 *
 * # The command must be readable, not merely present
 *
 * It used to render in a `whitespace-nowrap overflow-x-auto` code line, which
 * on a `lg` two-column layout cut the development command at
 * `--device-name b:` — mid-flag, with no visible affordance saying there was
 * more, next to a copy button that had already turned into a tick. A user who
 * types what they can see runs a command that does not parse. It now wraps.
 */

import { useCallback, useState } from "react"
import { useTranslations } from "next-intl"
import { CheckIcon, CopyIcon, InfoIcon, TerminalIcon } from "lucide-react"

import { Surface } from "@/components/surface/surface"
import { Button } from "@/components/ui/button"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { writeClipboardText } from "@/lib/tauri/clipboard"
import { DEFAULT_BROWSER_ACCESS_PORT } from "@/lib/connectivity/loopback-discovery"

/**
 * The development invitation is aimed at the **browser plane**, not the HTTPS
 * one every other client uses.
 *
 * `cognia-server pair` defaults to `https://127.0.0.1:27890`, and the pair step
 * then refuses that invitation itself: a browser can neither pin nor validate
 * the Host's self-signed certificate, which is what `web.httpsRequired` and the
 * `useLoopbackInvitation` remedy are about. `--advertise-url` points the
 * payload at the plaintext loopback listener instead — the one address a tab
 * reaches without a certificate — which `pnpm dev:web-headless` opens.
 *
 * The port is read from the shared constant so the command, the Rust default
 * and the discovery probe cannot drift apart.
 */
export const HEADLESS_PAIR_COMMANDS = {
  development: `pnpm --silent dev:headless pair --device-name browser --advertise-url http://127.0.0.1:${DEFAULT_BROWSER_ACCESS_PORT}`,
  compose:
    "docker compose -f deploy/compose/docker-compose.yml --profile server exec cognia-server cognia-server pair --device-name browser",
  kubernetes:
    "kubectl -n <namespace> exec -i cognia-server-0 -- cognia-server pair --device-name browser",
} as const

export type HeadlessPairMode = keyof typeof HEADLESS_PAIR_COMMANDS

export function HeadlessInvitationHelp() {
  const t = useTranslations("mobile.pair.web")
  const [mode, setMode] = useState<HeadlessPairMode>("development")
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)

  const onCopyCommand = useCallback(async () => {
    try {
      await writeClipboardText(HEADLESS_PAIR_COMMANDS[mode])
      setCopied(true)
      setCopyFailed(false)
    } catch {
      // A browser without clipboard-write permission fails here. Saying so
      // beats a tick that never appears: the command is still on screen to
      // select and copy by hand, which is what the sentence says.
      setCopied(false)
      setCopyFailed(true)
    }
  }, [mode])

  return (
    <Surface
      layer="raised"
      radius="panel"
      className="border border-border/70 p-3.5"
      data-testid="pair-headless-help"
    >
      <div className="flex items-start gap-2.5">
        <TerminalIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{t("headlessTitle")}</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {t("headlessDescription")}
          </p>
        </div>
      </div>

      <Tabs
        value={mode}
        onValueChange={(value) => {
          setMode(value as HeadlessPairMode)
          setCopied(false)
        }}
        className="mt-3 gap-2"
      >
        <TabsList className="grid h-auto w-full grid-cols-3">
          <TabsTrigger value="development" className="text-xs">
            {t("commandMode.development")}
          </TabsTrigger>
          <TabsTrigger value="compose" className="text-xs">
            {t("commandMode.compose")}
          </TabsTrigger>
          <TabsTrigger value="kubernetes" className="text-xs">
            {t("commandMode.kubernetes")}
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {/* One command element outside the Tabs rather than three TabsContent
          panes: the tab row selects which string to show, and mounting three
          copies meant three nodes carrying the same testid. */}
      <Surface
        layer="base"
        radius="control"
        className="mt-2 flex items-start gap-2 border px-3 py-2"
      >
        <code
          className="min-w-0 flex-1 font-mono text-[11px] leading-relaxed break-all"
          data-testid="pair-headless-command"
        >
          {HEADLESS_PAIR_COMMANDS[mode]}
        </code>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="-mt-0.5 -mr-1 shrink-0"
          onClick={() => void onCopyCommand()}
          aria-label={copied ? t("commandCopied") : t("copyCommand")}
          data-testid="pair-copy-command"
        >
          {copied ? (
            <CheckIcon className="size-3.5" aria-hidden="true" />
          ) : (
            <CopyIcon className="size-3.5" aria-hidden="true" />
          )}
        </Button>
      </Surface>

      {copyFailed ? (
        <p
          role="alert"
          className="mt-2 text-[11px] leading-relaxed text-destructive"
          data-testid="pair-copy-command-failed"
        >
          {t("clipboardWriteFailed")}
        </p>
      ) : null}

      <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
        {mode === "development"
          ? t("developmentCommandHint", { port: DEFAULT_BROWSER_ACCESS_PORT })
          : t("deploymentCommandHint")}
      </p>

      {/* The localStorage-credential warning. Standing context about how web
          pairing works, not an event — so it is a line here rather than the
          second full-width callout that used to push the form past the fold. */}
      <p
        className="mt-3 flex items-start gap-2 text-[11px] leading-relaxed text-muted-foreground"
        data-testid="pair-web-storage-notice"
      >
        <InfoIcon className="mt-px size-3.5 shrink-0" aria-hidden="true" />
        <span>
          <span className="font-medium text-foreground">{t("storageNoticeTitle")}</span>{" "}
          {t("storageNotice")}
        </span>
      </p>
    </Surface>
  )
}
