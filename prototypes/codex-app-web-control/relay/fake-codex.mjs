#!/usr/bin/env node

/** PROTOTYPE simulator used only by verify-simulator.mjs. */

import { createInterface } from "node:readline"

const activeThreadId = "thread_simulated_desktop"
let activeTurnId = null
let pendingApproval = null

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function result(id, value) {
  send({ id, result: value })
}

function notify(method, params) {
  send({ method, params })
}

function completeBrowserTurn() {
  if (!activeTurnId) return
  const code = pendingApproval?.code ?? "MISSING"
  notify("item/agentMessage/delta", {
    threadId: activeThreadId,
    turnId: activeTurnId,
    itemId: "agent_message_simulated",
    delta: `BROWSER_OK:${code}`,
  })
  notify("item/completed", {
    threadId: activeThreadId,
    turnId: activeTurnId,
    item: {
      type: "agentMessage",
      id: "agent_message_simulated",
      text: `BROWSER_OK:${code}`,
      phase: "final_answer",
    },
  })
  notify("turn/completed", {
    threadId: activeThreadId,
    turn: { id: activeTurnId, status: "completed", items: [] },
  })
  activeTurnId = null
  pendingApproval = null
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line)
  if (message.method === "initialize") {
    result(message.id, {
      userAgent: "fake-codex-app-server/0.0.0",
      codexHome: "/tmp/fake-codex-home",
      platformFamily: "unix",
      platformOs: "macos",
    })
    return
  }
  if (message.method === "initialized") return
  if (message.method === "thread/resume") {
    result(message.id, {
      thread: {
        id: message.params?.threadId ?? activeThreadId,
        cwd: process.cwd(),
        turns: [],
        status: { type: "idle" },
      },
    })
    return
  }
  if (message.method === "thread/read") {
    result(message.id, {
      thread: { id: message.params?.threadId ?? activeThreadId, cwd: process.cwd(), turns: [] },
    })
    return
  }
  if (message.method === "skills/list") {
    result(message.id, {
      data: [
        {
          cwd: process.cwd(),
          skills: [
            {
              name: "browser:control-in-app-browser",
              path: "/tmp/fake-browser-skill/SKILL.md",
              enabled: true,
            },
          ],
        },
      ],
    })
    return
  }
  if (message.method === "turn/start") {
    activeTurnId = `turn_simulated_${Date.now()}`
    const prompt = JSON.stringify(message.params?.input ?? [])
    const code = /COGNIA-BROWSER-[A-F0-9]+/.exec(prompt)?.[0] ?? "GENERIC"
    result(message.id, { turn: { id: activeTurnId, status: "inProgress", items: [] } })
    notify("turn/started", {
      threadId: message.params?.threadId ?? activeThreadId,
      turn: { id: activeTurnId, status: "inProgress", items: [] },
    })
    pendingApproval = { id: 9001, code }
    send({
      id: pendingApproval.id,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: activeThreadId,
        turnId: activeTurnId,
        itemId: "simulated_approval",
        reason: "Simulator checks that server requests remain desktop-owned",
      },
    })
    return
  }
  if (message.id === pendingApproval?.id && !message.method) {
    completeBrowserTurn()
    return
  }
  if (message.method === "turn/interrupt") {
    result(message.id, {})
    if (activeTurnId) {
      notify("turn/completed", {
        threadId: activeThreadId,
        turn: { id: activeTurnId, status: "interrupted", items: [] },
      })
      activeTurnId = null
    }
    return
  }
  if (message.id != null && message.method) {
    send({ id: message.id, error: { code: -32601, message: `Unknown method ${message.method}` } })
  }
})

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => process.exit(0))
}
