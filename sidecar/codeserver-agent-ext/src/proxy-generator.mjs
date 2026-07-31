import { createHash } from "node:crypto"
import JSZip from "jszip"
import { assertManagedContributionIds } from "./contribution-ids.mjs"

const FIXED_ZIP_DATE = new Date("1980-01-01T00:00:00.000Z")

export function buildProxyPackageJson(input) {
  validateInput(input)
  const name = proxyName(input.pluginId)
  const activationEvents = deriveActivationEvents(
    input.contributions,
    input.providers,
    input.protocols
  )
  return {
    name,
    displayName: `${input.pluginId} (Cognia Managed Proxy)`,
    description: `Platform-generated proxy for Cognia plugin ${input.pluginId}.`,
    version: input.pluginVersion,
    publisher: "cognia-managed",
    private: true,
    license: "SEE LICENSE IN COGNIA PLUGIN PACKAGE",
    engines: { vscode: "1.128.0" },
    categories: ["Other"],
    main: "./dist/proxy.js",
    extensionDependencies: ["cognia.cognia-managed-broker"],
    ...(activationEvents.length > 0 ? { activationEvents } : {}),
    extensionKind: ["workspace"],
    capabilities: {
      untrustedWorkspaces: {
        supported: "limited",
        description: "Execution providers require both Workspace Trust and Cognia authorization.",
      },
      virtualWorkspaces: { supported: "limited" },
    },
    contributes: structuredClone(input.contributions ?? {}),
    cogniaManaged: {
      pluginId: input.pluginId,
      pluginVersion: input.pluginVersion,
      manifestHash: input.manifestHash,
      catalogHash: input.catalogHash,
      platformVersion: "1.0.0",
      providers: structuredClone(input.providers ?? []),
      executables: structuredClone(input.executables ?? []),
      protocols: structuredClone(input.protocols ?? { lsp: [], dap: [], mcp: [] }),
    },
  }
}

export async function buildProxyVsix(input) {
  const pkg = buildProxyPackageJson(input)
  const zip = new JSZip()
  const files = new Map([
    ["[Content_Types].xml", Buffer.from(contentTypes(), "utf8")],
    ["extension.vsixmanifest", Buffer.from(vsixManifest(pkg), "utf8")],
    ["extension/package.json", Buffer.from(`${canonicalJson(pkg)}\n`, "utf8")],
    ["extension/dist/proxy.js", Buffer.from(input.proxyBundle)],
  ])
  for (const [path, bytes] of Object.entries(input.assets ?? {})) {
    validateAssetPath(path)
    files.set(`extension/${path}`, Buffer.from(bytes))
  }
  for (const path of [...files.keys()].sort()) {
    zip.file(path, files.get(path), { date: FIXED_ZIP_DATE, createFolders: true })
  }
  const bytes = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    platform: "UNIX",
    streamFiles: false,
  })
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  const signature = input.signDigest
    ? await input.signDigest(Buffer.from(sha256, "hex"))
    : undefined
  return {
    bytes,
    sha256,
    signature,
    filename: `cognia-managed.${pkg.name}-${pkg.version}.vsix`,
    packageJson: pkg,
  }
}

export function canonicalJson(value) {
  return JSON.stringify(sortValue(value))
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value && typeof value === "object" && !Buffer.isBuffer(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => value[key] !== undefined)
        .sort()
        .map((key) => [key, sortValue(value[key])])
    )
  }
  return value
}

function validateInput(input) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.pluginId ?? "")) {
    throw new Error(`IDE_PROXY_PLUGIN_ID_INVALID: ${String(input.pluginId)}`)
  }
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(input.pluginVersion ?? "")) {
    throw new Error(`IDE_PROXY_VERSION_INVALID: ${String(input.pluginVersion)}`)
  }
  const prefix = `cognia.${input.pluginId}.`
  assertManagedContributionIds(input.pluginId, input.contributions)
  for (const provider of input.providers ?? []) {
    if (!provider.id?.startsWith(prefix)) {
      throw new Error(`IDE_PROXY_ID_OUTSIDE_NAMESPACE: ${String(provider.id)}`)
    }
  }
}

function proxyName(pluginId) {
  return `proxy-${pluginId
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-|-$/g, "")}`
}

function deriveActivationEvents(contributions = {}, providers = [], protocols = {}) {
  const events = []
  for (const command of contributions.commands ?? []) events.push(`onCommand:${command.command}`)
  for (const language of contributions.languages ?? []) events.push(`onLanguage:${language.id}`)
  for (const views of Object.values(contributions.views ?? {})) {
    for (const view of views) events.push(`onView:${view.id}`)
  }
  for (const editor of contributions.customEditors ?? []) {
    events.push(`onCustomEditor:${editor.viewType}`)
  }
  for (const debuggerContribution of contributions.debuggers ?? []) {
    events.push(`onDebug:${debuggerContribution.type}`)
  }
  for (const task of contributions.taskDefinitions ?? []) events.push(`onTaskType:${task.type}`)
  for (const provider of providers ?? []) {
    const metadata = provider.metadata ?? {}
    if (provider.kind === "command") events.push(`onCommand:${provider.id}`)
    else if (provider.kind === "file-system") {
      events.push(`onFileSystem:${metadata.scheme}`)
    } else if (provider.kind.startsWith("debug-")) {
      events.push(`onDebug:${metadata.debugType}`)
    } else if (provider.kind === "task") {
      events.push(`onTaskType:${metadata.type}`)
    } else if (provider.kind === "terminal-profile") {
      events.push(`onTerminalProfile:${provider.id}`)
    } else if (provider.kind.startsWith("notebook-")) {
      events.push(`onNotebook:${metadata.notebookType}`)
    } else if (provider.kind === "uri-handler") {
      events.push("onUri")
    } else {
      const languages = selectorLanguages(provider.selector)
      if (languages.length > 0) {
        for (const language of languages) events.push(`onLanguage:${language}`)
      } else {
        events.push("onStartupFinished")
      }
    }
  }
  for (const server of protocols?.lsp ?? []) {
    if (server.languages?.length) {
      for (const language of server.languages) events.push(`onLanguage:${language}`)
    } else {
      events.push("onStartupFinished")
    }
  }
  if ((protocols?.dap?.length ?? 0) > 0 || (protocols?.mcp?.length ?? 0) > 0) {
    events.push("onStartupFinished")
  }
  return [...new Set(events)].sort()
}

function selectorLanguages(selector) {
  const selectors = Array.isArray(selector) ? selector : [selector]
  return selectors
    .flatMap((entry) => {
      if (typeof entry === "string") return [entry]
      if (entry && typeof entry.language === "string") return [entry.language]
      return []
    })
    .filter(Boolean)
}

function validateAssetPath(path) {
  const normalized = path.replaceAll("\\", "/")
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split("/").some((segment) => segment === ".." || segment === "")
  ) {
    throw new Error(`IDE_PROXY_ASSET_PATH_INVALID: ${path}`)
  }
}

function vsixManifest(pkg) {
  return `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="${escapeXml(pkg.name)}" Version="${escapeXml(pkg.version)}" Publisher="${escapeXml(pkg.publisher)}" />
    <DisplayName>${escapeXml(pkg.displayName)}</DisplayName>
    <Description xml:space="preserve">${escapeXml(pkg.description)}</Description>
    <Tags>cognia,managed,proxy</Tags>
    <Categories>Other</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${escapeXml(pkg.engines.vscode)}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="${escapeXml(pkg.extensionDependencies.join(","))}" />
    </Properties>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code" /></Installation>
  <Dependencies>
    <Dependency Id="cognia.cognia-managed-broker" DisplayName="Cognia Managed IDE Broker" Version="1.0.0" Publisher="cognia" />
  </Dependencies>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
  </Assets>
</PackageManifest>
`
}

function contentTypes() {
  return `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json" />
  <Default Extension="js" ContentType="application/javascript" />
  <Default Extension="svg" ContentType="image/svg+xml" />
  <Default Extension="vsixmanifest" ContentType="text/xml" />
</Types>
`
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
}
