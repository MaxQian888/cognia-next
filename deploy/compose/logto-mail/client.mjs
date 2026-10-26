import { Agent } from "node:https"
import upstreamGot from "got"

export * from "got"

// Allow idle TLS reuse across the recipient's 60-second resend cooldown.
// Bound both retained connections and active sockets for each configured origin.
const agent = new Agent({
  keepAlive: true,
  timeout: 90_000,
  maxSockets: 64,
  maxFreeSockets: 32,
  scheduling: "lifo",
})

export const got = upstreamGot.extend({
  agent: { https: agent },
  timeout: { request: 20_000 },
})
export default got
