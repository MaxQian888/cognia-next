import type {
  NormalizedPluginIdeManifest,
  PluginIdeManifest,
  PluginIdeProviderDeclaration,
} from "@/types/plugin/plugin-ide"
import type {
  VsCodeContributions,
  VsCodeExtensionBlock,
  VsCodeGrammar,
  VsCodeIconTheme,
  VsCodeLanguage,
  VsCodeSnippet,
} from "@/types/plugin/plugin-vscode"
import {
  IDE_CONTRIBUTION_KEYS,
  IDE_EXCLUDED_CONTRIBUTIONS,
  IDE_EXCLUDED_PROVIDERS,
  IDE_PROVIDER_CATALOG,
} from "./catalog"
import { validateIdeManifestSchema } from "./manifest-schema"

interface LegacyIdeFields {
  vscodeExtension?: Partial<VsCodeExtensionBlock> & {
    contributes?: VsCodeContributions
    extensionDependencies?: string[]
    extensionPack?: string[]
  }
  vscodeLanguages?: VsCodeLanguage[]
  vscodeGrammars?: VsCodeGrammar[]
  vscodeIconThemes?: VsCodeIconTheme[]
  vscodeSnippets?: VsCodeSnippet[]
}

export interface NormalizeIdeManifestInput extends LegacyIdeFields {
  ide?: PluginIdeManifest
}

export interface NormalizeIdeManifestResult {
  manifest: NormalizedPluginIdeManifest
  warnings: string[]
}

export class IdeManifestError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly field?: string
  ) {
    super(`${code}: ${message}`)
    this.name = "IdeManifestError"
  }
}

export function normalizeIdeManifest(
  pluginId: string,
  input: NormalizeIdeManifestInput
): NormalizeIdeManifestResult {
  if (
    input.vscodeExtension?.extensionDependencies?.length ||
    input.vscodeExtension?.extensionPack?.length
  ) {
    throw new IdeManifestError(
      "IDE_EXTENSION_DEPENDENCIES_UNSUPPORTED",
      "managed profiles do not install third-party extensionDependencies or extensionPack entries",
      "vscodeExtension.extensionDependencies"
    )
  }
  const hasLegacy = hasLegacyFields(input)
  if (input.ide && hasLegacy) {
    throw new IdeManifestError(
      "IDE_MANIFEST_AMBIGUOUS",
      "manifest.ide cannot be combined with legacy vscode* contribution fields"
    )
  }
  const warnings = hasLegacy ? ["IDE_LEGACY_MANIFEST_DEPRECATED"] : []
  const source = input.ide ?? legacyManifest(input)
  validateTopLevel(source)

  const validatedContributions = validateContributions(source.contributions ?? {})
  rejectProviderCompatibility(source.providers)
  rejectProtocolTransportCompatibility(source.protocols)
  const schemaDiagnostics = validateIdeManifestSchema(source)
  if (schemaDiagnostics.length > 0) {
    const diagnostic =
      schemaDiagnostics.find((entry) => entry.keyword === "required") ??
      schemaDiagnostics.toSorted((left, right) => right.field.length - left.field.length).at(0)!
    throw new IdeManifestError(
      diagnostic.code,
      `${diagnostic.field}: ${diagnostic.message}`,
      diagnostic.field
    )
  }
  const contributions = namespaceContributions(pluginId, validatedContributions)
  const providers = normalizeProviders(pluginId, source.targets, source.providers ?? [])
  const executables = source.executables?.map((entry) => structuredClone(entry)) ?? []
  validateExecutables(executables)
  const executableIds = new Set(executables.map((entry) => entry.id))
  const protocols = {
    lsp: source.protocols?.lsp?.map((entry) => structuredClone(entry)) ?? [],
    dap: source.protocols?.dap?.map((entry) => structuredClone(entry)) ?? [],
    mcp: source.protocols?.mcp?.map((entry) => structuredClone(entry)) ?? [],
  }
  for (const [family, servers] of Object.entries(protocols)) {
    const seenProtocolIds = new Set<string>()
    for (const server of servers) {
      server.id = namespaceId(pluginId, server.id)
      if (seenProtocolIds.has(server.id)) {
        throw new IdeManifestError(
          "IDE_PROTOCOL_ID_CONFLICT",
          `Duplicate ${family} protocol id: ${server.id}`,
          `ide.protocols.${family}`
        )
      }
      seenProtocolIds.add(server.id)
      if (!executableIds.has(server.executable)) {
        throw new IdeManifestError(
          "IDE_EXECUTABLE_NOT_DECLARED",
          `${family} server ${server.id} references undeclared executable ${server.executable}`,
          `ide.protocols.${family}`
        )
      }
      const allowedTransports: Record<string, Set<string>> = {
        lsp: new Set(["stdio", "socket"]),
        dap: new Set(["stdio", "socket"]),
        mcp: new Set(["stdio", "http", "sse"]),
      }
      if (!allowedTransports[family]?.has(server.transport)) {
        throw new IdeManifestError(
          "IDE_PROTOCOL_TRANSPORT_UNSUPPORTED",
          `${family} does not support ${server.transport} transport`,
          `ide.protocols.${family}`
        )
      }
      if (server.transport !== "stdio") {
        let endpoint: URL
        try {
          endpoint = new URL(server.endpoint ?? "")
        } catch {
          throw new IdeManifestError(
            "IDE_PROTOCOL_ENDPOINT_INVALID",
            `${family} ${server.transport} transport requires a loopback endpoint`,
            `ide.protocols.${family}`
          )
        }
        if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(endpoint.hostname)) {
          throw new IdeManifestError(
            "IDE_PROTOCOL_ENDPOINT_NOT_LOOPBACK",
            `${family} endpoints must remain on the Cognia host loopback interface`,
            `ide.protocols.${family}`
          )
        }
        const expectedProtocol = server.transport === "socket" ? "tcp:" : "http:"
        if (
          endpoint.protocol !== expectedProtocol ||
          endpoint.port.length === 0 ||
          endpoint.username.length > 0 ||
          endpoint.password.length > 0
        ) {
          throw new IdeManifestError(
            "IDE_PROTOCOL_ENDPOINT_INVALID",
            `${family} ${server.transport} endpoint must use ${expectedProtocol}//loopback:<port> without credentials`,
            `ide.protocols.${family}`
          )
        }
      }
    }
  }

  const agents =
    source.agents?.map((entry) => ({
      ...structuredClone(entry),
      id: namespaceId(pluginId, entry.id),
    })) ?? []
  if (agents.length > 0) {
    for (const agent of agents) {
      if (providers.some((provider) => provider.id === agent.id)) {
        throw new IdeManifestError(
          "IDE_PROVIDER_ID_CONFLICT",
          `Agent projection conflicts with provider id: ${agent.id}`,
          "ide.agents"
        )
      }
      providers.push({
        id: agent.id,
        kind: "chat-participant" as const,
        handler: `$agent:${agent.agentId}`,
        permission: "agent:control" as const,
        metadata: { agentId: agent.agentId },
      })
    }
  }

  return {
    manifest: {
      schemaVersion: 1,
      targets: [...new Set(source.targets)],
      requirements: {
        ...source.requirements,
        codeApiVersion: "1.128.0",
        brokerProtocol: "^1.0.0",
      },
      contributions,
      providers,
      executables,
      protocols,
      agents,
    },
    warnings,
  }
}

function hasLegacyFields(input: LegacyIdeFields): boolean {
  return Boolean(
    input.vscodeExtension?.contributes ||
    input.vscodeLanguages?.length ||
    input.vscodeGrammars?.length ||
    input.vscodeIconThemes?.length ||
    input.vscodeSnippets?.length
  )
}

function legacyManifest(input: LegacyIdeFields): PluginIdeManifest {
  const contributions: VsCodeContributions = input.vscodeExtension?.contributes ?? {}
  if (input.vscodeLanguages?.length) contributions.languages = input.vscodeLanguages
  if (input.vscodeGrammars?.length) contributions.grammars = input.vscodeGrammars
  if (input.vscodeIconThemes?.length) contributions.iconThemes = input.vscodeIconThemes
  if (input.vscodeSnippets?.length) contributions.snippets = input.vscodeSnippets
  return {
    schemaVersion: 1,
    targets: ["monaco", "pro-ide"],
    contributions,
  }
}

function validateTopLevel(manifest: PluginIdeManifest): void {
  if (manifest.schemaVersion !== 1) {
    throw new IdeManifestError(
      "IDE_SCHEMA_VERSION_UNSUPPORTED",
      `expected schemaVersion 1, received ${String(manifest.schemaVersion)}`,
      "ide.schemaVersion"
    )
  }
  if (!Array.isArray(manifest.targets) || manifest.targets.length === 0) {
    throw new IdeManifestError(
      "IDE_TARGET_REQUIRED",
      "at least one IDE target is required",
      "ide.targets"
    )
  }
  if (manifest.requirements?.codeApiVersion && manifest.requirements.codeApiVersion !== "1.128.0") {
    throw new IdeManifestError(
      "IDE_CODE_API_INCOMPATIBLE",
      "this host requires Code API 1.128.0",
      "ide.requirements.codeApiVersion"
    )
  }
}

function validateContributions(contributions: VsCodeContributions): VsCodeContributions {
  for (const key of Object.keys(contributions)) {
    if (!IDE_CONTRIBUTION_KEYS.has(key)) {
      const exclusionCode = IDE_EXCLUDED_CONTRIBUTIONS.get(key)
      throw new IdeManifestError(
        exclusionCode ?? "IDE_CONTRIBUTION_UNCLASSIFIED",
        exclusionCode
          ? `Code 1.128 contribution is explicitly excluded: ${key}`
          : `Unsupported or unclassified Code 1.128 contribution: ${key}`,
        `ide.contributions.${key}`
      )
    }
  }
  rejectProposedContributionFields(contributions)
  return structuredClone(contributions)
}

function rejectProviderCompatibility(value: unknown): void {
  if (!Array.isArray(value)) return
  for (const [index, provider] of value.entries()) {
    if (!provider || typeof provider !== "object" || Array.isArray(provider)) continue
    const kind = Reflect.get(provider, "kind")
    if (typeof kind !== "string" || IDE_PROVIDER_CATALOG.has(kind as never)) continue
    const exclusionCode = IDE_EXCLUDED_PROVIDERS.get(kind as "terminal-quick-fix")
    throw new IdeManifestError(
      exclusionCode ?? "IDE_PROVIDER_UNCLASSIFIED",
      exclusionCode
        ? `Code 1.128 provider is explicitly excluded: ${kind}`
        : `Unsupported or unclassified Code 1.128 provider: ${kind}`,
      `ide.providers[${index}].kind`
    )
  }
}

function rejectProtocolTransportCompatibility(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const allowedTransports: Record<string, Set<string>> = {
    lsp: new Set(["stdio", "socket"]),
    dap: new Set(["stdio", "socket"]),
    mcp: new Set(["stdio", "http", "sse"]),
  }
  for (const [family, servers] of Object.entries(value)) {
    if (!Array.isArray(servers)) continue
    for (const server of servers) {
      if (!server || typeof server !== "object" || Array.isArray(server)) continue
      const transport = Reflect.get(server, "transport")
      if (typeof transport === "string" && !allowedTransports[family]?.has(transport)) {
        throw new IdeManifestError(
          "IDE_PROTOCOL_TRANSPORT_UNSUPPORTED",
          `${family} does not support ${transport} transport`,
          `ide.protocols.${family}`
        )
      }
    }
  }
}

function rejectProposedContributionFields(contributions: VsCodeContributions): void {
  const reject = (path: string): never => {
    throw new IdeManifestError(
      "IDE_PROPOSED_API_UNSUPPORTED",
      `Code 1.128 contribution field requires a proposed API: ${path}`,
      `ide.contributions.${path}`
    )
  }
  for (const [index, item] of arrayEntries(contributions.viewsWelcome)) {
    if (hasOwn(item, "group")) reject(`viewsWelcome[${index}].group`)
  }
  if (hasOwn(contributions.terminal, "completionProviders")) {
    reject("terminal.completionProviders")
  }
  for (const [index, item] of arrayEntries(contributions.chatParticipants)) {
    for (const field of ["isDefault", "modes", "locations"] as const) {
      if (hasOwn(item, field)) reject(`chatParticipants[${index}].${field}`)
    }
  }
  for (const [index, item] of arrayEntries(contributions.customEditors)) {
    if (item.priority && typeof item.priority === "object") {
      reject(`customEditors[${index}].priority`)
    }
  }
  for (const [index, item] of arrayEntries(contributions.resourceLabelFormatters)) {
    if (hasOwn(item.formatting, "workspaceTooltip")) {
      reject(`resourceLabelFormatters[${index}].formatting.workspaceTooltip`)
    }
  }
  for (const [index, item] of arrayEntries(contributions.languageModelTools)) {
    if (hasOwn(item, "legacyToolReferenceFullNames")) {
      reject(`languageModelTools[${index}].legacyToolReferenceFullNames`)
    }
  }
  const viewContainers = objectValue(contributions.viewsContainers)
  for (const field of ["remote", "agentSessions"] as const) {
    if (hasOwn(viewContainers, field)) reject(`viewsContainers.${field}`)
  }
  const views = objectValue(contributions.views)
  for (const [container, values] of Object.entries(views)) {
    for (const [index, item] of arrayEntries(values)) {
      if (hasOwn(item, "accessibilityHelpContent")) {
        reject(`views.${container}[${index}].accessibilityHelpContent`)
      }
    }
  }
  const configurations = Array.isArray(contributions.configuration)
    ? contributions.configuration
    : [contributions.configuration]
  for (const [configurationIndex, configuration] of configurations.entries()) {
    const properties = objectValue(objectValue(configuration).properties)
    for (const [setting, value] of Object.entries(properties)) {
      if (hasOwn(value, "agentsWindow")) {
        reject(`configuration[${configurationIndex}].properties.${setting}.agentsWindow`)
      }
    }
  }
}

function arrayEntries(value: unknown): Array<[number, Record<string, unknown>]> {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry, index) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? ([[index, entry as Record<string, unknown>]] as const)
      : []
  )
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function hasOwn(value: unknown, key: string): boolean {
  return Boolean(value && typeof value === "object" && Object.hasOwn(value, key))
}

function normalizeProviders(
  pluginId: string,
  targets: readonly ("monaco" | "pro-ide")[],
  providers: PluginIdeProviderDeclaration[]
): PluginIdeProviderDeclaration[] {
  const metadataIdFields: Partial<Record<PluginIdeProviderDeclaration["kind"], string>> = {
    "text-document-content": "scheme",
    "file-system": "scheme",
    task: "type",
    "debug-configuration": "debugType",
    "debug-adapter": "debugType",
    "debug-tracker": "debugType",
    "notebook-serializer": "notebookType",
    "notebook-controller": "notebookType",
    "notebook-cell-status-bar": "notebookType",
    authentication: "authenticationProviderId",
    "language-model-chat-provider": "vendor",
    "webview-panel-serializer": "viewType",
  }
  const seen = new Set<string>()
  return providers.map((provider, index) => {
    const catalog = IDE_PROVIDER_CATALOG.get(provider.kind)
    if (!catalog) {
      const exclusionCode = IDE_EXCLUDED_PROVIDERS.get(provider.kind as "terminal-quick-fix")
      throw new IdeManifestError(
        exclusionCode ?? "IDE_PROVIDER_UNCLASSIFIED",
        exclusionCode
          ? `Code 1.128 provider is explicitly excluded: ${provider.kind}`
          : `Unsupported or unclassified Code 1.128 provider: ${provider.kind}`,
        `ide.providers[${index}].kind`
      )
    }
    if (!catalog.targets.some((target) => targets.includes(target))) {
      throw new IdeManifestError(
        "IDE_PROVIDER_TARGET_UNAVAILABLE",
        `${provider.kind} is not available for targets ${targets.join(", ")}`,
        `ide.providers[${index}].kind`
      )
    }
    const id = namespaceId(pluginId, provider.id)
    if (seen.has(id)) {
      throw new IdeManifestError(
        "IDE_PROVIDER_ID_CONFLICT",
        `Duplicate provider id: ${id}`,
        `ide.providers[${index}].id`
      )
    }
    seen.add(id)
    const proIdeOnly = catalog.targets.length === 1 && catalog.targets[0] === "pro-ide"
    const metadata = provider.metadata ? structuredClone(provider.metadata) : undefined
    const metadataIdField = metadataIdFields[provider.kind]
    if (metadataIdField) {
      const localMetadataId = metadata?.[metadataIdField]
      if (typeof localMetadataId !== "string" || localMetadataId.length === 0) {
        throw new IdeManifestError(
          "IDE_PROVIDER_METADATA_REQUIRED",
          `${provider.kind} requires metadata.${metadataIdField}`,
          `ide.providers[${index}].metadata.${metadataIdField}`
        )
      }
      metadata![metadataIdField] = namespaceId(pluginId, localMetadataId)
    }
    return {
      ...structuredClone(provider),
      id,
      ...(metadata ? { metadata } : {}),
      ...(catalog.permission ? { permission: catalog.permission } : {}),
      ...(proIdeOnly ? { proIdeOnly: true } : {}),
    }
  })
}

function validateExecutables(executables: NormalizedPluginIdeManifest["executables"]): void {
  const seen = new Set<string>()
  for (const [index, executable] of executables.entries()) {
    if (seen.has(executable.id)) {
      throw new IdeManifestError(
        "IDE_EXECUTABLE_ID_CONFLICT",
        `Duplicate executable id: ${executable.id}`,
        `ide.executables[${index}].id`
      )
    }
    seen.add(executable.id)
    if (
      executable.source.kind === "plugin-resource" &&
      (!isSafeRelativePath(executable.source.path) ||
        !/^sha256:[a-f0-9]{64}$/i.test(executable.source.sha256))
    ) {
      throw new IdeManifestError(
        "IDE_EXECUTABLE_RESOURCE_INVALID",
        `Executable path/hash must identify a signed plugin resource: ${executable.source.path}`,
        `ide.executables[${index}].source`
      )
    }
    if (
      (executable.source.kind === "registered-tool" &&
        executable.source.tool.trim().length === 0) ||
      (executable.source.kind === "user-selected" && executable.source.setting.trim().length === 0)
    ) {
      throw new IdeManifestError(
        "IDE_EXECUTABLE_SOURCE_INVALID",
        "Executable source identifier is required",
        `ide.executables[${index}].source`
      )
    }
    if (executable.args?.some((arg) => arg.includes("\0"))) {
      throw new IdeManifestError(
        "IDE_EXECUTABLE_ARGUMENT_INVALID",
        "Executable arguments may not contain NUL bytes",
        `ide.executables[${index}].args`
      )
    }
    const blockedEnvironment = new Set([
      "DYLD_INSERT_LIBRARIES",
      "DYLD_LIBRARY_PATH",
      "LD_PRELOAD",
      "NODE_OPTIONS",
      "ELECTRON_RUN_AS_NODE",
    ])
    for (const name of executable.allowedEnvironment ?? []) {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(name) || blockedEnvironment.has(name)) {
        throw new IdeManifestError(
          "IDE_EXECUTABLE_ENVIRONMENT_INVALID",
          `Environment variable is not safe to inherit: ${name}`,
          `ide.executables[${index}].allowedEnvironment`
        )
      }
    }
  }
}

function isSafeRelativePath(path: string): boolean {
  if (!path || path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) return false
  const segments = path.replaceAll("\\", "/").split("/")
  return segments.every((segment) => segment !== ".." && segment !== "")
}

function namespaceContributions(
  pluginId: string,
  contributions: VsCodeContributions
): VsCodeContributions {
  const mapIds = (ids: Iterable<string>): Map<string, string> =>
    new Map([...ids].map((id) => [id, namespaceId(pluginId, id)]))
  const rewrite = (value: string, ids: Map<string, string>): string => ids.get(value) ?? value
  const commands = mapIds(contributions.commands?.map((entry) => entry.command) ?? [])
  const submenus = mapIds(contributions.submenus?.map((entry) => entry.id) ?? [])
  const languages = mapIds(contributions.languages?.map((entry) => entry.id) ?? [])
  const viewContainers = mapIds(
    Object.values(contributions.viewsContainers ?? {}).flatMap((entries) =>
      entries.map((entry) => entry.id)
    )
  )
  const views = mapIds(
    Object.values(contributions.views ?? {}).flatMap((entries) => entries.map((entry) => entry.id))
  )
  if (contributions.commands) {
    contributions.commands = contributions.commands.map((entry) => ({
      ...entry,
      command: rewrite(entry.command, commands),
    }))
  }
  if (contributions.keybindings) {
    contributions.keybindings = contributions.keybindings.map((entry) => ({
      ...entry,
      command: rewrite(entry.command, commands),
    }))
  }
  if (contributions.submenus) {
    contributions.submenus = contributions.submenus.map((entry) => ({
      ...entry,
      id: rewrite(entry.id, submenus),
    }))
  }
  if (contributions.menus) {
    contributions.menus = Object.fromEntries(
      Object.entries(contributions.menus).map(([location, items]) => [
        rewrite(location, submenus),
        items.map((item) => ({
          ...item,
          ...(item.command ? { command: rewrite(item.command, commands) } : {}),
          ...(item.alt ? { alt: rewrite(item.alt, commands) } : {}),
          ...(item.submenu ? { submenu: rewrite(item.submenu, submenus) } : {}),
        })),
      ])
    )
  }
  if (contributions.languages) {
    contributions.languages = contributions.languages.map((entry) => ({
      ...entry,
      id: rewrite(entry.id, languages),
    }))
  }
  if (contributions.grammars) {
    contributions.grammars = contributions.grammars.map((entry) => ({
      ...entry,
      ...(entry.language ? { language: rewrite(entry.language, languages) } : {}),
    }))
  }
  if (contributions.snippets) {
    contributions.snippets = contributions.snippets.map((entry) => ({
      ...entry,
      language: entry.language
        .split(",")
        .map((id) => rewrite(id.trim(), languages))
        .join(","),
    }))
  }
  if (contributions.semanticTokenScopes) {
    contributions.semanticTokenScopes = contributions.semanticTokenScopes.map((entry) => ({
      ...entry,
      ...(entry.language ? { language: rewrite(entry.language, languages) } : {}),
    }))
  }
  if (contributions.viewsContainers) {
    contributions.viewsContainers = Object.fromEntries(
      Object.entries(contributions.viewsContainers).map(([location, entries]) => [
        location,
        entries.map((entry) => ({
          ...entry,
          id: rewrite(entry.id, viewContainers),
        })),
      ])
    ) as VsCodeContributions["viewsContainers"]
  }
  if (contributions.views) {
    contributions.views = Object.fromEntries(
      Object.entries(contributions.views).map(([container, entries]) => [
        rewrite(container, viewContainers),
        entries.map((entry) => ({ ...entry, id: rewrite(entry.id, views) })),
      ])
    )
  }
  if (contributions.viewsWelcome) {
    contributions.viewsWelcome = contributions.viewsWelcome.map((entry) => ({
      ...entry,
      view: rewrite(entry.view, views),
    }))
  }
  if (contributions.walkthroughs) {
    contributions.walkthroughs = contributions.walkthroughs.map((walkthrough) => {
      const steps = mapIds(walkthrough.steps.map((step) => step.id))
      return {
        ...walkthrough,
        id: namespaceId(pluginId, walkthrough.id),
        steps: walkthrough.steps.map((step) => ({
          ...step,
          id: rewrite(step.id, steps),
          completionEvents: step.completionEvents?.map((event) =>
            rewriteActivationReference(event, commands)
          ),
        })),
      }
    })
  }
  contributions.themes = contributions.themes?.map((entry) => ({
    ...entry,
    ...(entry.id ? { id: namespaceId(pluginId, entry.id) } : {}),
  }))
  contributions.iconThemes = contributions.iconThemes?.map((entry) => ({
    ...entry,
    id: namespaceId(pluginId, entry.id),
  }))
  contributions.productIconThemes = contributions.productIconThemes?.map((entry) => ({
    ...entry,
    id: namespaceId(pluginId, entry.id),
  }))
  contributions.colors = contributions.colors?.map((entry) => ({
    ...entry,
    id: namespaceId(pluginId, entry.id),
  }))
  if (contributions.icons) {
    contributions.icons = Object.fromEntries(
      Object.entries(contributions.icons).map(([id, icon]) => [namespaceId(pluginId, id), icon])
    )
  }
  contributions.customEditors = contributions.customEditors?.map((entry) => ({
    ...entry,
    viewType: namespaceId(pluginId, entry.viewType),
  }))
  if (contributions.notebooks) {
    contributions.notebooks = contributions.notebooks.map((entry) => ({
      ...entry,
      type: namespaceId(pluginId, entry.type),
    }))
  }
  if (contributions.notebookRenderer) {
    contributions.notebookRenderer = contributions.notebookRenderer.map((entry) => ({
      ...entry,
      id: namespaceId(pluginId, entry.id),
    }))
  }
  contributions.debuggers = contributions.debuggers?.map((entry) => ({
    ...entry,
    type: namespaceId(pluginId, entry.type),
    languages: entry.languages?.map((id) => rewrite(id, languages)),
  }))
  contributions.breakpoints = contributions.breakpoints?.map((entry) => ({
    ...entry,
    language: rewrite(entry.language, languages),
  }))
  contributions.taskDefinitions = contributions.taskDefinitions?.map((entry) => ({
    ...entry,
    type: namespaceId(pluginId, entry.type),
  }))
  contributions.problemMatchers = contributions.problemMatchers?.map((entry) => ({
    ...entry,
    name: namespaceId(pluginId, entry.name),
  }))
  contributions.problemPatterns = contributions.problemPatterns?.map((entry) => ({
    ...entry,
    name: namespaceId(pluginId, entry.name),
  }))
  if (contributions.terminal?.profiles) {
    contributions.terminal = {
      ...contributions.terminal,
      profiles: contributions.terminal.profiles.map((entry) => ({
        ...entry,
        id: namespaceId(pluginId, entry.id),
      })),
    }
  }
  contributions.authentication = contributions.authentication?.map((entry) => ({
    ...entry,
    id: namespaceId(pluginId, entry.id),
  }))
  contributions.mcpServerDefinitionProviders = contributions.mcpServerDefinitionProviders?.map(
    (entry) => ({
      ...entry,
      id: namespaceId(pluginId, entry.id),
    })
  )
  contributions.languageModelChatProviders = contributions.languageModelChatProviders?.map(
    (entry) => ({
      ...entry,
      vendor: namespaceId(pluginId, entry.vendor),
      ...(entry.managementCommand
        ? { managementCommand: rewrite(entry.managementCommand, commands) }
        : {}),
    })
  )
  contributions.languageModelTools = contributions.languageModelTools?.map((entry) => ({
    ...entry,
    name: namespaceId(pluginId, entry.name),
  }))
  if (contributions.chatParticipants) {
    contributions.chatParticipants = contributions.chatParticipants.map((entry) => ({
      ...entry,
      id: namespaceId(pluginId, entry.id),
    }))
  }
  if (contributions.localizations) {
    contributions.localizations = contributions.localizations.map((entry) => ({
      ...entry,
      languageId: namespaceId(pluginId, entry.languageId),
    }))
  }
  return contributions
}

function rewriteActivationReference(event: string, commands: Map<string, string>): string {
  const prefix = "onCommand:"
  return event.startsWith(prefix)
    ? `${prefix}${commands.get(event.slice(prefix.length)) ?? event.slice(prefix.length)}`
    : event
}

export function namespaceId(pluginId: string, localId: string): string {
  const prefix = `cognia.${pluginId}.`
  if (localId.startsWith(prefix)) return localId
  if (localId.startsWith("cognia.")) {
    throw new IdeManifestError(
      "IDE_CONTRIBUTION_ID_RESERVED",
      `Contribution id is reserved by another Cognia namespace: ${localId}`
    )
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(localId)) {
    throw new IdeManifestError(
      "IDE_CONTRIBUTION_ID_INVALID",
      `Contribution id contains unsupported characters: ${localId}`
    )
  }
  return `${prefix}${localId}`
}
