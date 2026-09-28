import test from "node:test"
import assert from "node:assert/strict"
import { RECENT_COMMAND_SESSIONS, dropDuplicateCommand } from "./ledger.ts"

test("duplicate commandIds are acked once and dropped; LRU caps at 128", () => {
  const sessions = new Map([["s1", {}]])
  const ledger = new Map()
  const out: unknown[] = []
  const emit = (m: unknown) => out.push(m)
  const drop = (msg: Parameters<typeof dropDuplicateCommand>[1]) =>
    dropDuplicateCommand(sessions, msg, emit, ledger)

  assert.equal(drop({ sessionId: "s1", commandId: "c1" }), false)
  assert.equal(drop({ sessionId: "s1", commandId: "c1" }), true)
  assert.deepEqual(out, [
    { type: "command_ack", sessionId: "s1", commandId: "c1", duplicate: true },
  ])

  // Fill past the LRU cap: the oldest id ages out and is processable again.
  for (let i = 0; i < 130; i += 1) drop({ sessionId: "s1", commandId: `fill-${i}` })
  assert.equal(drop({ sessionId: "s1", commandId: "c1" }), false)

  // Messages without ids are never dropped. A first-seen id is never dropped
  // either, whether or not the session is live.
  assert.equal(drop({ sessionId: "s1" }), false)
  assert.equal(drop({ sessionId: "ghost", commandId: "x" }), false)
})

test("a retried send is still dropped after the Anthropic session was retired", () => {
  // The single-turn rail evicts its session on `session_ended`. A redrive that
  // lands after that used to find no session, no ledger, and re-run the turn.
  const sessions = new Map([["s1", { multiTurn: false }]])
  const ledger = new Map()
  const out: unknown[] = []
  const emit = (m: unknown) => out.push(m)
  assert.equal(
    dropDuplicateCommand(sessions, { sessionId: "s1", commandId: "turn-1" }, emit, ledger),
    false
  )
  sessions.delete("s1") // the turn ended
  assert.equal(
    dropDuplicateCommand(sessions, { sessionId: "s1", commandId: "turn-1" }, emit, ledger),
    true
  )
  assert.deepEqual(out, [
    { type: "command_ack", sessionId: "s1", commandId: "turn-1", duplicate: true },
  ])
})

test("the command ledger forgets the least recently driven session past its cap", () => {
  const ledger = new Map()
  const emit = () => {}
  for (let i = 0; i < RECENT_COMMAND_SESSIONS + 1; i += 1) {
    dropDuplicateCommand(new Map(), { sessionId: `s${i}`, commandId: "c" }, emit, ledger)
  }
  assert.equal(ledger.size, RECENT_COMMAND_SESSIONS)
  assert.equal(ledger.has("s0"), false, "the oldest session aged out")
  // A session touched again is the newest, so it survives the next eviction.
  dropDuplicateCommand(new Map(), { sessionId: "s1", commandId: "c2" }, emit, ledger)
  dropDuplicateCommand(new Map(), { sessionId: "fresh", commandId: "c" }, emit, ledger)
  assert.equal(ledger.has("s1"), true)
  assert.equal(ledger.has("s2"), false)
})
