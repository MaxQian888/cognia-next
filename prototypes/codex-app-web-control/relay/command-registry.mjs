import { randomUUID } from "node:crypto"

const COMMAND_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/

function commandMetadata(command) {
  const { execute: _execute, validate: _validate, ...metadata } = command
  return metadata
}

export function createCommandRegistry(commands, options = {}) {
  const byId = new Map()
  for (const command of commands) {
    if (!COMMAND_PATTERN.test(command.id)) throw new Error(`invalid command id: ${command.id}`)
    if (byId.has(command.id)) throw new Error(`duplicate command id: ${command.id}`)
    if (typeof command.execute !== "function")
      throw new Error(`command has no handler: ${command.id}`)
    byId.set(command.id, Object.freeze({ mutates: true, ...command }))
  }

  let serial = Promise.resolve()
  const publish = options.publish ?? (() => {})

  function list() {
    return [...byId.values()].map(commandMetadata)
  }

  async function execute(request, context = {}) {
    const command = byId.get(request?.command)
    if (!command) throw new Error(`unknown command: ${String(request?.command ?? "")}`)
    const requestId =
      typeof request.requestId === "string" && request.requestId.length <= 128
        ? request.requestId
        : randomUUID()
    const input = request.input && typeof request.input === "object" ? request.input : {}
    const run = async () => {
      publish("command/started", { requestId, command: command.id })
      try {
        const validated = command.validate ? await command.validate(input, context) : input
        const result = await command.execute(validated, context)
        publish("command/completed", { requestId, command: command.id })
        return { requestId, command: command.id, result }
      } catch (error) {
        publish("command/failed", {
          requestId,
          command: command.id,
          error: error instanceof Error ? error.message : String(error),
        })
        throw error
      }
    }
    if (command.mutates === false) return run()
    const pending = serial.then(run, run)
    serial = pending.catch(() => {})
    return pending
  }

  return { list, execute }
}
