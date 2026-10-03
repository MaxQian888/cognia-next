/**
 * `vscode.extensions`: the VS Code extensions installed in the app.
 *
 * The renderer reports them (`extensions:changed`, before activation and
 * whenever one is installed, removed, enabled or disabled): each one's id,
 * install directory and whether it is running. `packageJSON` is read from
 * that directory. Lookups are case-insensitive, as in VS Code.
 *
 * Each extension runs in its own host process, so another extension's
 * `exports` cannot reach this one: they are `undefined`, and its
 * `activate()` starts it (or waits for it) and resolves to `undefined`. An
 * extension's own entry carries its real exports.
 */

import { readFileSync } from "node:fs"
import * as nodePath from "node:path"

import type { RpcConnection } from "../rpc"
import { ExtensionKind } from "./api-types"
import { EventEmitter, Uri } from "./types"
import type { ShimDependencies } from "./index"

export interface ReportedExtension {
  id: string
  extensionPath: string
  isActive: boolean
}

export class ExtensionRegistry {
  private entries = new Map<string, ReportedExtension>()
  private readonly exportsById = new Map<string, unknown>()
  private readonly packageJsons = new Map<string, Record<string, unknown>>()
  readonly onDidChange = new EventEmitter<void>()

  attach(connection: RpcConnection): void {
    connection.onRequest("extensions:changed", (params) => {
      const { extensions } = params as { extensions?: ReportedExtension[] }
      this.set(Array.isArray(extensions) ? extensions : [])
      return null
    })
  }

  set(extensions: ReportedExtension[]): void {
    const next = new Map(extensions.map((entry) => [entry.id.toLowerCase(), entry]))
    const same =
      next.size === this.entries.size &&
      [...next].every(([key, entry]) => {
        const previous = this.entries.get(key)
        return (
          previous?.extensionPath === entry.extensionPath && previous.isActive === entry.isActive
        )
      })
    this.entries = next
    if (!same) this.onDidChange.fire(undefined)
  }

  /** The exports an extension's `activate()` returned in this host. */
  setExports(id: string, exports: unknown): void {
    this.exportsById.set(id.toLowerCase(), exports)
  }

  clearExports(id: string): void {
    this.exportsById.delete(id.toLowerCase())
  }

  get(id: string): ReportedExtension | undefined {
    return this.entries.get(id.toLowerCase())
  }

  all(): ReportedExtension[] {
    return [...this.entries.values()]
  }

  exportsOf(id: string): unknown {
    return this.exportsById.get(id.toLowerCase())
  }

  hasExports(id: string): boolean {
    return this.exportsById.has(id.toLowerCase())
  }

  /** The extension's `package.json`, read once; `{}` when it cannot be read. */
  packageJson(extensionPath: string): Record<string, unknown> {
    const cached = this.packageJsons.get(extensionPath)
    if (cached) return cached
    let parsed: Record<string, unknown> = {}
    try {
      const value: unknown = JSON.parse(
        readFileSync(nodePath.join(extensionPath, "package.json"), "utf-8")
      )
      if (value && typeof value === "object" && !Array.isArray(value)) {
        parsed = value as Record<string, unknown>
      }
    } catch {
      // Unreadable: answered as empty, and read again next time.
      return parsed
    }
    this.packageJsons.set(extensionPath, parsed)
    return parsed
  }
}

/** VS Code's `Extension<T>`, over one reported extension. */
class Extension {
  readonly extensionKind = ExtensionKind.Workspace

  constructor(
    private readonly registry: ExtensionRegistry,
    private readonly connection: RpcConnection,
    private readonly callerId: string,
    private readonly entry: ReportedExtension
  ) {}

  get id(): string {
    return this.entry.id
  }
  get extensionPath(): string {
    return this.entry.extensionPath
  }
  get extensionUri(): Uri {
    return Uri.file(this.entry.extensionPath)
  }
  get isActive(): boolean {
    if (this.isSelf()) return this.registry.hasExports(this.entry.id)
    return this.registry.get(this.entry.id)?.isActive ?? false
  }
  get packageJSON(): Record<string, unknown> {
    return this.registry.packageJson(this.entry.extensionPath)
  }
  /** Only this extension's own; another's live in its own process. */
  get exports(): unknown {
    return this.isSelf() ? this.registry.exportsOf(this.entry.id) : undefined
  }

  async activate(): Promise<unknown> {
    if (this.isSelf()) return this.registry.exportsOf(this.entry.id)
    await this.connection.sendRequest("extensions:activate", {
      extensionId: this.callerId,
      id: this.entry.id,
    })
    return undefined
  }

  private isSelf(): boolean {
    return this.entry.id.toLowerCase() === this.callerId.toLowerCase()
  }
}

export function createExtensionsNamespace(deps: ShimDependencies) {
  const { connection, extensionId, extensions: registry } = deps
  const wrap = (entry: ReportedExtension) => new Extension(registry, connection, extensionId, entry)
  return {
    get all(): Extension[] {
      return registry.all().map(wrap)
    },
    /** Extensions run in one kind of host here, so this is `all`. */
    get allAcrossExtensionHosts(): Extension[] {
      return registry.all().map(wrap)
    },
    getExtension(id: string): Extension | undefined {
      const entry = registry.get(id)
      return entry ? wrap(entry) : undefined
    },
    onDidChange: registry.onDidChange.event,
  }
}
