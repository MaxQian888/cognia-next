import { Transform } from "node:stream"
import { StringDecoder } from "node:string_decoder"

// Kept separate from the live entry so fixture checks never dispatch a model.
export function createLiveStreamCompat(onRepair) {
  const decoder = new StringDecoder("utf8")
  let pending = ""
  function line(value) {
    if (!value.startsWith("data:")) return value
    let event
    try {
      event = JSON.parse(value.slice(5).trim())
    } catch {
      return value
    }
    let changed = false
    for (const choice of Array.isArray(event?.choices) ? event.choices : []) {
      for (const call of Array.isArray(choice?.delta?.tool_calls) ? choice.delta.tool_calls : []) {
        if (call?.type !== "") continue
        delete call.type
        changed = true
        onRepair("chat-empty-tool-type")
      }
    }
    if (
      event?.type === "response.output_item.added" &&
      event.item?.type === "function_call" &&
      !Object.hasOwn(event.item, "arguments")
    ) {
      event.item.arguments = ""
      changed = true
      onRepair("responses-missing-start-arguments")
    }
    if (!changed) return value
    const ending = value.endsWith("\r\n") ? "\r\n" : value.endsWith("\n") ? "\n" : ""
    return `data: ${JSON.stringify(event)}${ending}`
  }
  return new Transform({
    transform(chunk, _encoding, callback) {
      pending += decoder.write(chunk)
      let newline
      while ((newline = pending.indexOf("\n")) !== -1) {
        this.push(line(pending.slice(0, newline + 1)))
        pending = pending.slice(newline + 1)
      }
      callback()
    },
    flush(callback) {
      pending += decoder.end()
      if (pending) this.push(line(pending))
      callback()
    },
  })
}
