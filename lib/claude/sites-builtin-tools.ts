/**
 * Cognia Sites tools (agent ⇄ Sites), ADR-0084.
 *
 * Surfaced to the agent as plugin-manifest entries on the same wire as the
 * editor built-ins, and resolved host-side in `plugin-tool-ipc` — *not* in
 * `sidecar/builtin-tools/`. The sidecar is a pure `.mjs` process with no Dexie,
 * no OS keyring, and no Tauri `invoke`; every step of a publish needs all three
 * (`listSiteProjects` reads IndexedDB, the provider token comes out of the
 * keyring, and the build runs through `sandbox_exec`).
 *
 * Consent is tiered rather than uniform — see
 * `./permissions/site-tool-rules`. Listing is a read. Building produces an
 * immutable local version and publishes nothing, which is why the console's own
 * gate for it is `edit` rather than `deploy`; making it ask would turn "prepare
 * a release" into a click-through and train the user to approve everything,
 * which is exactly how the `deploy_site` prompt loses its meaning. Deploying
 * puts a URL other people can load in front of the world, with no undo —
 * `takeDown` removes the Site, it does not restore the previous version.
 */
import type { EditorBuiltinManifestEntry } from "./editor-builtin-tools"

export const SITES_BUILTIN_PLUGIN_ID = "cognia-sites-builtin"

export const LIST_SITES_TOOL_NAME = "list_sites"
export const BUILD_SITE_TOOL_NAME = "build_site"
export const DEPLOY_SITE_TOOL_NAME = "deploy_site"

/** Every Sites tool, in the order they are surfaced to the model. */
export const SITES_TOOL_NAMES = [
  LIST_SITES_TOOL_NAME,
  BUILD_SITE_TOOL_NAME,
  DEPLOY_SITE_TOOL_NAME,
] as const

export type SitesToolName = (typeof SITES_TOOL_NAMES)[number]

const LIST_SITES_SCHEMA = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const

const BUILD_SITE_SCHEMA = {
  type: "object",
  properties: {
    siteId: { type: "string", description: "The Site to build, from list_sites." },
    buildNetworkHosts: {
      type: "array",
      items: { type: "string" },
      description:
        "Hosts the build command may reach. Omit for no network, which is the default — only name hosts the build genuinely needs.",
    },
  },
  required: ["siteId"],
  additionalProperties: false,
} as const

const DEPLOY_SITE_SCHEMA = {
  type: "object",
  properties: {
    siteId: { type: "string", description: "The Site to publish, from list_sites." },
    versionId: {
      type: "string",
      description: "Version to publish. Omit to publish the newest ready version.",
    },
  },
  required: ["siteId"],
  additionalProperties: false,
} as const

/** Same wire shape the editor built-ins use — `build-options` appends both. */
export function buildSitesBuiltinManifestEntries(): EditorBuiltinManifestEntry[] {
  return [
    {
      name: LIST_SITES_TOOL_NAME,
      description:
        "List the user's Cognia Sites: id, name, worker name, lifecycle, and the live production URL when there is one. Read-only.",
      jsonSchema: LIST_SITES_SCHEMA as unknown as Record<string, unknown>,
      pluginId: SITES_BUILTIN_PLUGIN_ID,
    },
    {
      name: BUILD_SITE_TOOL_NAME,
      description:
        "Build a Cognia Site into a new immutable version. Runs the project's build in an OS sandbox with no network unless hosts are named. Publishes nothing — use deploy_site for that. Returns the new version, or the build's failure message.",
      jsonSchema: BUILD_SITE_SCHEMA as unknown as Record<string, unknown>,
      pluginId: SITES_BUILTIN_PLUGIN_ID,
    },
    {
      name: DEPLOY_SITE_TOOL_NAME,
      description:
        "Publish a built Site version to Cloudflare so it serves public traffic. Irreversible: taking the Site down removes it, it does not restore the previous version. Returns the production URL.",
      jsonSchema: DEPLOY_SITE_SCHEMA as unknown as Record<string, unknown>,
      pluginId: SITES_BUILTIN_PLUGIN_ID,
    },
  ]
}

/** Is this tool name one of the Sites built-ins? */
export function isSitesBuiltinTool(name: string): name is SitesToolName {
  return (SITES_TOOL_NAMES as readonly string[]).includes(name)
}

export interface SitesToolRunDeps {
  listSites: () => Promise<unknown>
  build: (input: { siteId: string; buildNetworkHosts: string[] }) => Promise<unknown>
  deploy: (input: { siteId: string; versionId?: string }) => Promise<unknown>
}

/**
 * Resolve the tools against the renderer.
 *
 * Every dependency lives here rather than in the sidecar: `listSites` reads
 * Dexie, `build` runs through `sandbox_exec`, and `deploy` loads the provider
 * token from the OS keyring. The actor comes from the account store and is
 * never a tool argument — an agent that could name an account would make
 * `assertSiteAuthoringCapability` pass for whatever it named.
 */
export async function resolveSitesToolDeps(): Promise<SitesToolRunDeps> {
  const { useAccountStore } = await import("@/stores/account/account-store")
  const actor = () => {
    const actorAccountId = useAccountStore.getState().unlockedAccountId
    if (!actorAccountId) throw new Error("unlock your account before publishing a Site")
    return actorAccountId
  }
  return {
    listSites: async () => (await import("@/lib/plugin/api/sites")).listSites(),
    build: async ({ siteId, buildNetworkHosts }) => {
      const [{ buildAndSaveSiteVersion }, { listSiteEnvironmentRevisions }, consoleModel, inputs] =
        await Promise.all([
          import("@/lib/sites/build-version"),
          import("@/lib/db/sites"),
          import("@/lib/sites/console-model"),
          import("@/lib/sites/build-inputs"),
        ])
      const environment = consoleModel.latestEnvironmentRevision(
        await listSiteEnvironmentRevisions(siteId)
      )
      if (!environment) throw new Error("save an environment revision for this Site first")
      const version = await buildAndSaveSiteVersion({
        siteId,
        environmentRevisionId: environment.id,
        runtime: inputs.SITE_BUILD_INPUT_DEFAULTS.runtime,
        packageManager: inputs.SITE_BUILD_INPUT_DEFAULTS.packageManager,
        installNetworkHosts: inputs.SITE_BUILD_INPUT_DEFAULTS.installNetworkHosts,
        buildNetworkHosts,
        actorAccountId: actor(),
      })
      return {
        versionId: version.id,
        sequence: version.sequence,
        status: version.status,
        commitSha: version.source.commitSha,
        dirty: version.source.dirty,
      }
    },
    deploy: async ({ siteId, versionId }) => {
      const [{ publishSiteVersion }, { listSiteVersions }] = await Promise.all([
        import("@/lib/sites/publish-version"),
        import("@/lib/db/sites"),
      ])
      const versions = await listSiteVersions(siteId)
      const target = versionId
        ? versions.find((version) => version.id === versionId)
        : versions.find((version) => version.status === "ready")
      if (!target) throw new Error("no ready version to publish")
      const deployment = await publishSiteVersion({
        siteId,
        versionId: target.id,
        actorAccountId: actor(),
      })
      return {
        versionId: target.id,
        deploymentId: deployment.id,
        status: deployment.status,
        productionUrl: deployment.productionUrl ?? null,
      }
    },
  }
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required`)
  return value.trim()
}

export async function runSitesBuiltinTool(
  name: string,
  args: Record<string, unknown>,
  deps: SitesToolRunDeps
): Promise<unknown> {
  if (name === LIST_SITES_TOOL_NAME) return deps.listSites()
  if (name === BUILD_SITE_TOOL_NAME) {
    const hosts = Array.isArray(args.buildNetworkHosts)
      ? args.buildNetworkHosts.filter((host): host is string => typeof host === "string")
      : []
    return deps.build({ siteId: requireString(args, "siteId"), buildNetworkHosts: hosts })
  }
  if (name === DEPLOY_SITE_TOOL_NAME) {
    const versionId = typeof args.versionId === "string" ? args.versionId : undefined
    return deps.deploy({
      siteId: requireString(args, "siteId"),
      ...(versionId ? { versionId } : {}),
    })
  }
  throw new Error(`unknown Sites tool: ${name}`)
}
