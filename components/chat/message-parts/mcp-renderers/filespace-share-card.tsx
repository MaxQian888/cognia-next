"use client"

/**
 * The result of an agent's `filespace_share` / `filespace_enable_webdav` call
 * (ADR-0222 §9), for the person.
 *
 * A snapshot shows its link with a copy button. Live access shows where it is
 * served and its usernames — and, because the agent never sees a password,
 * an "Issue password" button per credential. Issuing rotates the credential
 * on the host that serves it (`rotateLiveCredential`, the same call as the
 * Files panel's) and shows the new password once, on whichever device the
 * person is reading the conversation on; nothing secret is ever stored in the
 * message. A share for a shared conversation's members has no sign-in at
 * all: it names who is admitted and where they open the files. A refusal
 * renders nothing here, so the generic tool block shows the agent's own
 * explanation.
 */

import { useState } from "react"
import type { SessionRole } from "@cognia/agent-config-types"
import type { ToolUIPart } from "ai"
import { useFormatter, useTranslations } from "next-intl"
import { CopyIcon, HardDriveIcon, KeyRoundIcon, LinkIcon, UsersIcon } from "lucide-react"
import { toast } from "sonner"

import { LiveShareCredentials } from "@/components/filespace/live-share-credentials"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { fileShareErrorDetails, rotateLiveCredential } from "@/lib/filespace/grants-client"
import { writeClipboardText } from "@/lib/tauri/clipboard"
import type { IssuedLiveCredential, LiveEndpoints, LiveProtocol } from "@/types/filespace/live"

import { useParsedOutput } from "./common"

interface SnapshotOutput {
  ok: true
  mode: "snapshot"
  url: string
  expiresAt?: number
  files: number
  withheldSensitive?: number
}

interface LiveOutput {
  ok: true
  mode: "live"
  grantId: string
  hostId: string
  paths: string[]
  expiresAt: number
  credentials: { credentialId: string; protocol: LiveProtocol; username: string }[]
  endpoints: LiveEndpoints
}

/** Live access for the shared conversation's members: no credentials. */
interface MembersOutput {
  ok: true
  mode: "live"
  audience: "members"
  grantId: string
  hostId: string
  minRole: SessionRole
  permissions: string[]
  paths: string[]
  expiresAt: number
}

type ShareOutput = SnapshotOutput | LiveOutput | MembersOutput | { ok?: false }

function isSnapshot(output: ShareOutput): output is SnapshotOutput {
  return output.ok === true && (output as SnapshotOutput).mode === "snapshot"
}

function isMembers(output: ShareOutput): output is MembersOutput {
  return (
    output.ok === true &&
    (output as MembersOutput).mode === "live" &&
    (output as MembersOutput).audience === "members"
  )
}

function isLive(output: ShareOutput): output is LiveOutput {
  return (
    output.ok === true &&
    (output as LiveOutput).mode === "live" &&
    Array.isArray((output as LiveOutput).credentials)
  )
}

export function FilespaceShareCard({ part }: { part: ToolUIPart; sessionId?: string }) {
  const output = useParsedOutput<ShareOutput>(part.output)
  if (!output) return null
  if (isSnapshot(output)) return <SnapshotResult output={output} />
  if (isMembers(output)) return <MembersResult output={output} />
  if (isLive(output)) return <LiveResult output={output} />
  return null
}

function SnapshotResult({ output }: { output: SnapshotOutput }) {
  const t = useTranslations("filespace.agentCard")
  const format = useFormatter()
  const copy = () =>
    void writeClipboardText(output.url).then(
      () => toast.success(t("copied")),
      () => toast.error(t("copyFailed"))
    )
  return (
    <div
      className="my-1 space-y-1.5 rounded-md border px-3 py-2 text-xs"
      data-testid="filespace-share-snapshot"
    >
      <p className="flex items-center gap-1.5 font-medium">
        <LinkIcon className="size-3.5" aria-hidden />
        {t("snapshotTitle", { count: output.files })}
      </p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded bg-muted px-1.5 py-0.5">{output.url}</code>
        <Button type="button" size="sm" variant="outline" className="h-7 gap-1" onClick={copy}>
          <CopyIcon className="size-3.5" aria-hidden />
          {t("copy")}
        </Button>
      </div>
      {output.expiresAt !== undefined ? (
        <p className="text-muted-foreground">
          {t("expires", {
            when: format.dateTime(new Date(output.expiresAt), {
              dateStyle: "medium",
              timeStyle: "short",
            }),
          })}
        </p>
      ) : null}
      {output.withheldSensitive ? (
        <p className="text-muted-foreground">
          {t("withheldSensitive", { count: output.withheldSensitive })}
        </p>
      ) : null}
    </div>
  )
}

const SESSION_ROLES: readonly SessionRole[] = ["viewer", "member", "maintainer", "owner"]

function MembersResult({ output }: { output: MembersOutput }) {
  const t = useTranslations("filespace.agentCard")
  const tl = useTranslations("liveShare")
  const format = useFormatter()
  const role = SESSION_ROLES.includes(output.minRole) ? output.minRole : "viewer"
  return (
    <div
      className="my-1 space-y-1.5 rounded-md border px-3 py-2 text-xs"
      data-testid="filespace-share-members"
    >
      <p className="flex items-center gap-1.5 font-medium">
        <UsersIcon className="size-3.5" aria-hidden />
        {tl("dialog.members.resultTitle")}
      </p>
      <p className="text-muted-foreground">
        {tl("grants.audience.members", { role: tl(`dialog.members.role.${role}`) })}
      </p>
      <p className="truncate font-mono text-muted-foreground" title={output.paths.join("\n")}>
        {output.paths.join(", ")}
      </p>
      <p className="text-muted-foreground">
        {t("expires", {
          when: format.dateTime(new Date(output.expiresAt), {
            dateStyle: "medium",
            timeStyle: "short",
          }),
        })}
      </p>
      <p>{t("membersNote")}</p>
    </div>
  )
}

function LiveResult({ output }: { output: LiveOutput }) {
  const t = useTranslations("filespace.agentCard")
  const tl = useTranslations("liveShare")
  const format = useFormatter()
  const [issuing, setIssuing] = useState<string | null>(null)
  const [issued, setIssued] = useState<IssuedLiveCredential | null>(null)

  const issue = async (credentialId: string) => {
    setIssuing(credentialId)
    try {
      setIssued(await rotateLiveCredential(credentialId, { hostId: output.hostId }))
    } catch (error) {
      const { code, message } = fileShareErrorDetails(error)
      toast.error(tl(`errors.${code}`, { message }))
    } finally {
      setIssuing(null)
    }
  }

  return (
    <div
      className="my-1 space-y-1.5 rounded-md border px-3 py-2 text-xs"
      data-testid="filespace-share-live"
    >
      <p className="flex items-center gap-1.5 font-medium">
        <HardDriveIcon className="size-3.5" aria-hidden />
        {t("liveTitle")}
      </p>
      <p className="truncate font-mono text-muted-foreground" title={output.paths.join("\n")}>
        {output.paths.join(", ")}
      </p>
      <p className="text-muted-foreground">
        {t("expires", {
          when: format.dateTime(new Date(output.expiresAt), {
            dateStyle: "medium",
            timeStyle: "short",
          }),
        })}
      </p>
      <p>{t("passwordNote")}</p>
      <div className="flex flex-wrap gap-1.5">
        {output.credentials.map((credential) => (
          <Button
            key={credential.credentialId}
            type="button"
            size="sm"
            variant="outline"
            className="h-7 gap-1"
            disabled={issuing !== null}
            onClick={() => void issue(credential.credentialId)}
          >
            <KeyRoundIcon className="size-3.5" aria-hidden />
            {t("issuePassword", {
              protocol: tl(`credentials.protocol.${credential.protocol}`),
              username: credential.username,
            })}
          </Button>
        ))}
      </div>

      <Dialog open={issued !== null} onOpenChange={(open) => !open && setIssued(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
          {issued ? (
            <>
              <DialogHeader>
                <DialogTitle>
                  {tl("grants.rotate.title", { username: issued.credential.username })}
                </DialogTitle>
                <DialogDescription>{t("issuedDescription")}</DialogDescription>
              </DialogHeader>
              <LiveShareCredentials credentials={[issued]} endpoints={output.endpoints} />
              <DialogFooter>
                <Button type="button" onClick={() => setIssued(null)}>
                  {tl("dialog.done")}
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  )
}
