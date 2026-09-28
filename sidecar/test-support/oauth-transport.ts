import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js"

/** No-I/O transport used to exercise OAuth state transitions in unit tests. */
export class FakeOAuthTransport {
  async start() {}
  async send(_message: JSONRPCMessage) {}
  async close() {}
}
