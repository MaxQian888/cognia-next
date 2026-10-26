#!/usr/bin/env node
// Fixture debug adapter for the managed Pro IDE's real-binary E2E.
//
// Launch prints one output event naming the program it was asked to run, then
// ends the session. That is enough to prove the DAP path end to end: VS Code →
// the proxy's descriptor factory → the broker → the supervised process → back.
// Self-contained for the same reason as the language server beside it.

let buffer = Buffer.alloc(0)
let seq = 1

function send(message) {
  const body = Buffer.from(JSON.stringify({ seq: seq++, ...message }), "utf8")
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`)
  process.stdout.write(body)
}

const respond = (request, body = {}) =>
  send({
    type: "response",
    request_seq: request.seq,
    success: true,
    command: request.command,
    body,
  })
const event = (name, body) => send({ type: "event", event: name, ...(body ? { body } : {}) })

function handle(request) {
  if (request.type !== "request") return
  switch (request.command) {
    case "initialize":
      respond(request, { supportsConfigurationDoneRequest: true })
      event("initialized")
      break
    case "launch":
      respond(request)
      event("output", {
        category: "stdout",
        output: `Cognia fixture debug: ${request.arguments?.program ?? "no program"}\n`,
      })
      event("terminated")
      event("exited", { exitCode: 0 })
      break
    case "disconnect":
      respond(request)
      setTimeout(() => process.exit(0), 10)
      break
    case "threads":
      respond(request, { threads: [{ id: 1, name: "main" }] })
      break
    default:
      respond(request)
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    const headerEnd = buffer.indexOf("\r\n\r\n")
    if (headerEnd < 0) return
    const match = /Content-Length: (\d+)/i.exec(buffer.subarray(0, headerEnd).toString("ascii"))
    if (!match) {
      buffer = buffer.subarray(headerEnd + 4)
      continue
    }
    const length = Number(match[1])
    if (buffer.length < headerEnd + 4 + length) return
    const body = buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString("utf8")
    buffer = buffer.subarray(headerEnd + 4 + length)
    handle(JSON.parse(body))
  }
})
