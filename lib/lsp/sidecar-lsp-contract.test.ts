/**
 * The sidecar reads the renderer's resolved LSP settings through its own types
 * (`sidecar/src/services/lsp/servers.ts`), because it cannot import this
 * package at runtime. The type aliases below stop compiling when the
 * renderer's shapes drift away from what the sidecar reads, and the test runs
 * the builtin defaults through the sidecar's own `buildServers`.
 */
import type { LspSendOptions, LspServerConfig } from "@/types/lsp/config"
import { buildServers } from "../../sidecar/src/services/lsp/servers.ts"
import type {
  LspSendOptions as SidecarLspSendOptions,
  LspServerEntry,
} from "../../sidecar/src/services/lsp/servers.ts"
import { BUILTIN_LSP_SERVERS } from "./builtin-defaults"

/** Compiles only when `Value` is assignable to `Target`. */
type AssignableTo<Target, Value extends Target> = Value

export type ServerConfigFeedsSidecar = AssignableTo<LspServerEntry, LspServerConfig>
export type SendOptionsFeedSidecar = AssignableTo<SidecarLspSendOptions, LspSendOptions>

describe("sidecar LSP contract", () => {
  it("builds a runnable server from every builtin default", () => {
    const built = buildServers(BUILTIN_LSP_SERVERS)
    expect(built.map((s) => s.id)).toEqual(BUILTIN_LSP_SERVERS.map((s) => s.id))
    for (const server of built) {
      const config = BUILTIN_LSP_SERVERS.find((s) => s.id === server.id)!
      expect(server.resolveCommand("/workspace").command).toBe(config.command)
      expect(server.extensions).toEqual((config.extensions ?? []).map((e) => e.toLowerCase()))
    }
  })
})
