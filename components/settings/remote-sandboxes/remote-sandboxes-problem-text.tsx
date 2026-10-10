"use client"

/**
 * A refusal from the remote sandbox settings commands, in words.
 *
 * The Host's `code` picks the sentence; its `message` is the detail the
 * sentence carries, because the Rust validation names the exact field and
 * value it refused and that is what a person needs to fix it. A code this
 * build does not know still shows the Host's message.
 */

import { useTranslations } from "next-intl"

import type { RemoteSandboxesProblem } from "@/hooks/sandbox/use-remote-sandboxes"

const KNOWN_CODES = new Set([
  "remote_sandboxes_invalid",
  "remote_sandboxes_registry_invalid",
  "remote_sandboxes_unwritable",
  "remote_sandboxes_unreadable",
  "remote_sandboxes_version_unsupported",
  "remote_sandboxes_secret_unwritable",
  "remote_sandboxes_secret_id_invalid",
  "remote_sandboxes_secret_unreferenced",
  "remote_sandboxes_secret_empty",
])

export function remoteSandboxesProblemKey(code: string): string {
  return KNOWN_CODES.has(code) ? code : "unknown"
}

export function RemoteSandboxesProblemText({ problem }: { problem: RemoteSandboxesProblem }) {
  const t = useTranslations("settings.remoteSandboxes.errors")
  return (
    <p role="alert" className="text-xs text-destructive" data-code={problem.code}>
      {t(remoteSandboxesProblemKey(problem.code), { message: problem.message || problem.code })}
    </p>
  )
}
