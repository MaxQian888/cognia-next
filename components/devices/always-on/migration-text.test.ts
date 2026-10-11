/** @jest-environment jsdom */
import { renderHook } from "@testing-library/react"

import type { MachineBoundReason } from "@/lib/placement/machine-bound"
import { MIGRATION_BLOCKER_KINDS, type MigrationBlocker } from "@/lib/remote-host/migration/types"

import { useMigrationText } from "./migration-text"

const REASONS: MachineBoundReason[] = [
  { kind: "os-promotion" },
  { kind: "task-type-unsupported", taskType: "backup", reason: "missing-capability", missing: [] },
  { kind: "machine-maintenance", taskType: "backup" },
  { kind: "local-process", taskType: "monitor" },
  { kind: "managed-by", manager: "bot-installation" },
  { kind: "local-event", eventType: "session.idle" },
  { kind: "desktop-trigger", triggerId: "pet" },
  { kind: "local-path", field: "cwd", path: "/Users/me/notes" },
  { kind: "local-project-root", projectId: "p", path: "/Users/me/repo" },
  { kind: "stdio-mcp", serverId: "fs", name: "Filesystem" },
  { kind: "keyring-reference", ref: "openai:key" },
  { kind: "loopback-endpoint", field: "url", url: "http://localhost:11434" },
  { kind: "webhook-endpoint" },
]

const BLOCKERS: Record<MigrationBlocker["kind"], MigrationBlocker> = {
  "host-unreachable": { kind: "host-unreachable", detail: "no route" },
  "host-too-old": { kind: "host-too-old" },
  "already-moved": { kind: "already-moved", hostLabel: "VPS" },
  "machine-bound": { kind: "machine-bound", reason: { kind: "os-promotion" } },
  "plugin-missing": { kind: "plugin-missing", pluginId: "acme-notes", version: "1.0.0" },
  "plugin-version-mismatch": {
    kind: "plugin-version-mismatch",
    pluginId: "acme-notes",
    version: "2.0.0",
    hostVersion: "1.0.0",
  },
  "bot-definition-missing": {
    kind: "bot-definition-missing",
    definitionId: "acme.helper",
    version: "1.0.0",
  },
  "reference-missing": { kind: "reference-missing", reference: "workflow", id: "wf-1" },
  "depends-on": {
    kind: "depends-on",
    item: { kind: "connector-instance", id: "c1" },
    label: "Team Telegram",
  },
  "id-conflict": { kind: "id-conflict", id: "t1" },
  "secret-unreadable": { kind: "secret-unreadable", name: "c1:token" },
}

function text() {
  return renderHook(() => useMigrationText()).result.current
}

describe("useMigrationText", () => {
  it("has a sentence for every blocker kind, with its facts in it", () => {
    const t = text()
    for (const kind of MIGRATION_BLOCKER_KINDS) {
      const sentence = t.blocker(BLOCKERS[kind], "Mac mini")
      expect(sentence).not.toMatch(/^(blocker|reason)\./)
      expect(sentence).not.toContain("{")
    }
    expect(t.blocker(BLOCKERS["plugin-version-mismatch"], "Mac mini")).toBe(
      "Needs the plugin acme-notes 2.0.0; Mac mini has 1.0.0."
    )
    expect(t.blocker(BLOCKERS["reference-missing"], "Mac mini")).toBe(
      "Uses the workflow “wf-1”, which Mac mini does not have."
    )
  })

  it("explains every machine-bound reason in plain words", () => {
    const t = text()
    for (const reason of REASONS) {
      const sentence = t.blocker({ kind: "machine-bound", reason }, "Mac mini")
      expect(sentence).not.toMatch(/^reason\./)
      expect(sentence).not.toContain("{")
    }
    expect(
      t.blocker(
        { kind: "machine-bound", reason: { kind: "managed-by", manager: "connector-instance" } },
        "Mac mini"
      )
    ).toBe("Belongs to a Connection and moves with it.")
  })

  it("names notes, item kinds and journal states", () => {
    const t = text()
    expect(t.note({ kind: "secret-transferred", name: "c1:token" }, "Mac mini")).toBe(
      "The secret c1:token is copied into Mac mini's keychain."
    )
    expect(t.note({ kind: "schedules-travel", count: 3 }, "Mac mini")).toBe(
      "Its 3 scheduled messages set up in chats move to Mac mini with it."
    )
    expect(t.kind("bot-installation")).toBe("Bot")
    expect(t.state("awaiting-host")).toBe("waiting to reach the host")
  })
})
