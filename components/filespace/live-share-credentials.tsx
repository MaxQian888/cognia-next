"use client"

/**
 * What someone needs to connect to a live share (ADR-0222 §7.5): each
 * credential's username and one-time password, where to dial, the
 * fingerprints to verify, and the steps for Finder, Windows, rclone and
 * OpenSSH.
 *
 * Shown right after a grant is created and after a password is rotated; the
 * password exists only in that answer, so the card says so first.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { CheckIcon, CopyIcon, EyeIcon, EyeOffIcon, TriangleAlertIcon } from "lucide-react"
import { toast } from "sonner"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { mountInstructionsFor, type MountInstructions } from "@/lib/filespace/mount-instructions"
import { writeClipboardText } from "@/lib/tauri/clipboard"
import { cn } from "@/lib/utils"
import {
  LIVE_UNAVAILABLE_REASONS,
  type IssuedLiveCredential,
  type LiveEndpoints,
} from "@/types/filespace/live"

export interface LiveShareCredentialsProps {
  credentials: IssuedLiveCredential[]
  endpoints: LiveEndpoints
}

export function LiveShareCredentials({ credentials, endpoints }: LiveShareCredentialsProps) {
  const t = useTranslations("liveShare")
  const reason = endpoints.unavailableReason
  return (
    <div className="space-y-3" data-testid="live-share-credentials">
      <Alert>
        <TriangleAlertIcon aria-hidden />
        <AlertDescription>{t("credentials.onceWarning")}</AlertDescription>
      </Alert>
      {reason ? (
        <Alert variant="destructive" data-testid="live-share-unavailable">
          <AlertDescription>
            {t(
              `unavailable.${(LIVE_UNAVAILABLE_REASONS as readonly string[]).includes(reason) ? reason : "unknown"}`
            )}
          </AlertDescription>
        </Alert>
      ) : null}
      {credentials.map((issued) => (
        <CredentialCard key={issued.credential.id} issued={issued} endpoints={endpoints} />
      ))}
      {endpoints.tlsFingerprint ? (
        <Fingerprint
          label={t("credentials.tls")}
          hint={t("credentials.tlsHint")}
          value={endpoints.tlsFingerprint}
        />
      ) : null}
    </div>
  )
}

function CredentialCard({
  issued,
  endpoints,
}: {
  issued: IssuedLiveCredential
  endpoints: LiveEndpoints
}) {
  const t = useTranslations("liveShare")
  const { credential, password } = issued
  const steps = mountInstructionsFor(credential, password, endpoints)
  return (
    <section
      className="space-y-2 rounded-md border p-3"
      aria-label={t(`credentials.protocol.${credential.protocol}`)}
      data-testid={`live-credential-${credential.protocol}`}
    >
      <Badge variant="secondary">{t(`credentials.protocol.${credential.protocol}`)}</Badge>
      <CopyValue label={t("credentials.username")} value={credential.username} />
      <SecretValue label={t("credentials.password")} value={password} />
      {credential.sshKeyFingerprint ? (
        <p className="text-xs text-muted-foreground">
          {t("credentials.sshKey", { fingerprint: credential.sshKeyFingerprint })}
        </p>
      ) : null}
      {steps.length > 0 ? (
        <>
          <p className="text-xs font-medium">{t("credentials.endpoints")}</p>
          {steps.map((step, index) => (
            <Steps key={index} step={step} />
          ))}
          {credential.protocol === "sftp" && endpoints.sftpHostKeyFingerprint ? (
            <Fingerprint
              label={t("credentials.hostKey")}
              hint={t("credentials.hostKeyHint")}
              value={endpoints.sftpHostKeyFingerprint}
            />
          ) : null}
        </>
      ) : (
        <p className="text-xs text-muted-foreground">{t("credentials.noInstructions")}</p>
      )}
    </section>
  )
}

function Steps({ step }: { step: MountInstructions }) {
  const t = useTranslations("liveShare")
  if (step.protocol === "sftp") {
    const address = `${step.host}:${step.port}`
    return (
      <div className="space-y-1">
        <CopyValue label={t("credentials.endpoints")} value={address} hideLabel />
        <Tabs defaultValue="sftp">
          <TabsList className="h-8">
            <TabsTrigger value="sftp" className="text-xs">
              {t("credentials.tab.sftp")}
            </TabsTrigger>
            <TabsTrigger value="rclone" className="text-xs">
              {t("credentials.tab.rclone")}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="sftp" className="space-y-1">
            <p className="text-xs text-muted-foreground">{t("credentials.steps.sftp")}</p>
            <Command value={step.sftpCommand} />
          </TabsContent>
          <TabsContent value="rclone" className="space-y-1">
            <p className="text-xs text-muted-foreground">{t("credentials.steps.rclone")}</p>
            {step.rcloneCommands.map((command) => (
              <Command key={command} value={command} />
            ))}
          </TabsContent>
        </Tabs>
      </div>
    )
  }
  return (
    <div className="space-y-1">
      <CopyValue label={t("credentials.endpoints")} value={step.url} hideLabel />
      <Tabs defaultValue="finder">
        <TabsList className="h-8">
          <TabsTrigger value="finder" className="text-xs">
            {t("credentials.tab.finder")}
          </TabsTrigger>
          <TabsTrigger value="windows" className="text-xs">
            {t("credentials.tab.windows")}
          </TabsTrigger>
          <TabsTrigger value="rclone" className="text-xs">
            {t("credentials.tab.rclone")}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="finder" className="space-y-1">
          <p className="text-xs text-muted-foreground">{t("credentials.steps.finder")}</p>
          <Command value={step.finderUrl} />
        </TabsContent>
        <TabsContent value="windows" className="space-y-1">
          <p className="text-xs text-muted-foreground">{t("credentials.steps.windows")}</p>
          <Command value={step.windowsCommand} />
          {step.windowsNeedsHttps ? (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              {t("credentials.steps.windowsNeedsHttps")}
            </p>
          ) : null}
        </TabsContent>
        <TabsContent value="rclone" className="space-y-1">
          <p className="text-xs text-muted-foreground">{t("credentials.steps.rclone")}</p>
          {step.rcloneCommands.map((command) => (
            <Command key={command} value={command} />
          ))}
        </TabsContent>
      </Tabs>
    </div>
  )
}

function Fingerprint({ label, hint, value }: { label: string; hint: string; value: string }) {
  return (
    <div className="space-y-0.5">
      <CopyValue label={label} value={value} />
      <p className="text-[11px] text-muted-foreground">{hint}</p>
    </div>
  )
}

function Command({ value }: { value: string }) {
  const t = useTranslations("liveShare")
  return (
    <div className="flex items-start gap-1 rounded bg-muted px-2 py-1">
      <code className="min-w-0 flex-1 break-all font-mono text-[11px]">{value}</code>
      <CopyButton value={value} label={t("credentials.copy", { label: value })} />
    </div>
  )
}

/** A labelled value with a copy button; the label can stay for screen readers only. */
export function CopyValue({
  label,
  value,
  hideLabel = false,
}: {
  label: string
  value: string
  hideLabel?: boolean
}) {
  const t = useTranslations("liveShare")
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className={cn("w-24 shrink-0 text-xs text-muted-foreground", hideLabel && "sr-only")}>
        {label}
      </span>
      <code className="min-w-0 flex-1 truncate font-mono text-xs" title={value}>
        {value}
      </code>
      <CopyButton value={value} label={t("credentials.copy", { label })} />
    </div>
  )
}

function SecretValue({ label, value }: { label: string; value: string }) {
  const t = useTranslations("liveShare")
  const [shown, setShown] = useState(false)
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="w-24 shrink-0 text-xs text-muted-foreground">{label}</span>
      <code className="min-w-0 flex-1 truncate font-mono text-xs" data-testid="live-password">
        {shown ? value : "•".repeat(Math.min(value.length, 24))}
      </code>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7"
        aria-label={shown ? t("credentials.hide") : t("credentials.show")}
        aria-pressed={shown}
        onClick={() => setShown((current) => !current)}
      >
        {shown ? <EyeOffIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
      </Button>
      <CopyButton value={value} label={t("credentials.copy", { label })} />
    </div>
  )
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const t = useTranslations("liveShare")
  const [copied, setCopied] = useState(false)
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-7 shrink-0"
      aria-label={label}
      title={copied ? t("credentials.copied") : label}
      onClick={() => {
        void writeClipboardText(value).then(
          () => setCopied(true),
          () => toast.error(t("credentials.copyFailed"))
        )
      }}
    >
      {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
    </Button>
  )
}
