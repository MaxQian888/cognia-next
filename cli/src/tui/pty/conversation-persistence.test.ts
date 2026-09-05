/**
 * What survives quitting.
 *
 * The fixture used to hand the App no-op persistence, so nothing it wrote
 * outlived the process and the whole "restart and it is still there" class went
 * untested through the terminal. It now writes to the driver's isolated home,
 * which two runs can share.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { runConversation, type ConversationSession } from "./conversation-driver"
import { HISTORY_FILE_NAME } from "../input/history-store"

jest.setTimeout(120_000)

function scratchHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cognia-persist-"))
}

/** Slash suggestions can contain the full command before typing has finished.
 * Wait for the composer itself before sending Enter so it cannot be coalesced
 * with a trailing character into a pasted newline. */
async function command(session: ConversationSession, value: string): Promise<void> {
  await session.type(value)
  await session.waitFor((screen) => screen.split("\n").some((row) => row.includes(`› ${value}`)))
  await session.press("enter")
}

describe("across a restart", () => {
  it("browses and resumes valid history beside corrupt files, exports it, then starts fresh", async () => {
    const home = scratchHome()
    try {
      fs.mkdirSync(path.join(home, "sessions"))
      const entries = [
        { ts: 1, role: "user", content: "SAVED_SESSION_QUESTION" },
        { ts: 2, role: "assistant", content: "SAVED_SESSION_REPLY" },
      ]
      fs.writeFileSync(
        path.join(home, "sessions", "saved.jsonl"),
        ["null", "{}", ...entries.map((e) => JSON.stringify(e))].join("\n")
      )
      fs.mkdirSync(path.join(home, "sessions", "unreadable.jsonl"))
      const result = await runConversation({ scenario: {}, home, cwd: home }, async (session) => {
        await command(session, "/sessions")
        await session.waitForText("Resume session")
        await session.waitForText("SAVED_SESSION_QUESTION")
        await session.press("enter")
        await session.waitForText("SAVED_SESSION_REPLY")
        await command(session, "/transcript")
        await session.waitForText("q/esc close")
        await session.waitForText("SAVED_SESSION_REPLY")
        await session.press("escape")
        await session.waitForNoText("q/esc close")
        await command(session, "/export json")
        await session.waitForText("Exported 2 entries")
        expect(
          JSON.parse(fs.readFileSync(path.join(home, "cognia-export-saved.json"), "utf8"))
        ).toEqual(entries)
        await command(session, "/clear")
        await session.waitForText("Enter confirm")
        await session.press("escape")
        await session.waitForNoText("Enter confirm")
        await session.waitForText("SAVED_SESSION_REPLY")
        await command(session, "/new --yes")
        await session.waitForNoText("SAVED_SESSION_REPLY")
        await command(session, "/retry")
        await session.waitForText("Nothing to re-send yet")
        expect(fs.readFileSync(path.join(home, "sessions", "saved.jsonl"), "utf8")).toContain(
          "SAVED_SESSION_REPLY"
        )
      })
      expect(result.record.prompts).toEqual([])
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it("retries a failed prompt exactly once using only the scripted agent", async () => {
    const result = await runConversation(
      {
        scenario: {
          turns: [
            { steps: [{ kind: "fail", message: "OFFLINE_RETRY_FAILURE", recoverable: true }] },
            { steps: [{ kind: "text", delta: "OFFLINE_RETRY_SUCCESS" }] },
          ],
        },
      },
      async (session) => {
        await session.send("retry this exact question")
        await session.waitForText("OFFLINE_RETRY_FAILURE")
        await command(session, "/retry")
        await session.waitForText("OFFLINE_RETRY_SUCCESS")
      }
    )
    expect(result.record.prompts).toEqual([
      "retry this exact question",
      "retry this exact question",
    ])
  })

  it("offers the previous run's prompts to the up arrow", async () => {
    const home = scratchHome()
    try {
      await runConversation(
        { scenario: { fallback: { steps: [{ kind: "text", delta: "noted" }] } }, home },
        async (session) => {
          await session.send("remember this line")
          await session.waitForText("noted")
        }
      )

      await runConversation(
        { scenario: { fallback: { steps: [{ kind: "text", delta: "again" }] } }, home },
        async (session) => {
          // A fresh process, a fresh composer, and the history behind it.
          await session.press("up")
          await session.waitForText("remember this line")
        }
      )
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it("keeps two homes out of each other's history", async () => {
    const first = scratchHome()
    const second = scratchHome()
    try {
      await runConversation(
        { scenario: { fallback: { steps: [{ kind: "text", delta: "ok" }] } }, home: first },
        async (session) => {
          await session.send("private to the first home")
          await session.waitForText("ok")
        }
      )

      await runConversation(
        { scenario: { fallback: { steps: [{ kind: "text", delta: "ok" }] } }, home: second },
        async (session) => {
          await session.press("up")
          // Nothing to recall, so the composer stays empty rather than
          // borrowing another session's line.
          await session.waitForNoText("private to the first home")
        }
      )
    } finally {
      fs.rmSync(first, { recursive: true, force: true })
      fs.rmSync(second, { recursive: true, force: true })
    }
  })

  it("starts clean on a truncated history file rather than refusing to boot", async () => {
    const home = scratchHome()
    try {
      // Half a JSON document, which is what a process killed mid-write leaves.
      fs.writeFileSync(path.join(home, HISTORY_FILE_NAME), '{"entries": ["half a li')
      await runConversation(
        { scenario: { fallback: { steps: [{ kind: "text", delta: "still here" }] } }, home },
        async (session) => {
          await session.send("does it boot")
          await session.waitForText("still here")
        }
      )
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})
