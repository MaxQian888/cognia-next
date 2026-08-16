import {
  DSH_PLATFORMS,
  dshRuntimeChannelSchema,
  isReadOnlyProfile,
  profileTransport,
  type DshPlatform,
  type DshProfileDescriptor,
  DSH_ACP_CAPABILITIES,
  DSH_SDK_CAPABILITIES,
  type DshCapabilitySnapshot,
  type DshProfileId,
  type DshRuntimeChannel,
} from "@/types/agent/dsh-runtime-channel"

/**
 * Install / doctor / launch policy for a Cognia-owned DeepSeek Harness runtime.
 *
 * Deliberately pure: no filesystem, no crypto, no process spawning. Digests are
 * computed by whichever host owns the bytes — Rust on desktop, Node in
 * CLI/headless — and passed in here as strings. That keeps every rule in one
 * place and testable, instead of duplicated across the Tauri command and the
 * Node backend where the two could drift.
 *
 * @see runtime/deepseek-harness/README.md
 */

/** Filesystem facts a caller gathers before asking for a verdict. */
export interface DshInstalledRuntimeFacts {
  lockfileDigest: string
  compositionDigest: string
  /** `process.version`-style string, e.g. `v26.3.1`. */
  nodeVersion: string
  platform: string
  /**
   * Paths found under the runtime's `DSH_HOME` that DSH would apply as user
   * patch layers. Any entry here is a hole in the certification.
   */
  strayPatchPaths?: readonly string[]
  /** Whether a C/C++ toolchain is available, when one is needed. */
  hasNativeToolchain?: boolean
}

export type DshDoctorSeverity = "error" | "warning"

export interface DshDoctorFinding {
  code:
    | "channel-malformed"
    | "lockfile-digest-mismatch"
    | "composition-digest-mismatch"
    | "node-version-unsupported"
    | "platform-unsupported"
    | "stray-patch-layer"
    | "native-toolchain-missing"
  severity: DshDoctorSeverity
  /** Non-localized detail for logs. UI strings come from i18n keyed on `code`. */
  detail: string
}

export interface DshDoctorReport {
  healthy: boolean
  findings: DshDoctorFinding[]
}

/** Parse `v26.3.1` / `26.3.1` into a major number. */
export function parseNodeMajor(nodeVersion: string): number | undefined {
  const match = /^v?(\d+)\./.exec(nodeVersion.trim())
  if (!match) return undefined
  const major = Number.parseInt(match[1], 10)
  return Number.isFinite(major) ? major : undefined
}

export function isSupportedDshPlatform(platform: string): platform is DshPlatform {
  return (DSH_PLATFORMS as readonly string[]).includes(platform)
}

/**
 * Build the `<os>-<arch>` key used by the channel manifest.
 *
 * Node's `process.platform` / `process.arch` spellings are already the ones
 * upstream's prebuild directories use, so no translation table is needed.
 */
export function dshPlatformKey(osPlatform: string, arch: string): string {
  return `${osPlatform}-${arch}`
}

export function findProfile(
  channel: DshRuntimeChannel,
  profileId: DshProfileId
): DshProfileDescriptor | undefined {
  return channel.profiles.find((profile) => profile.profileId === profileId)
}

/**
 * Decide whether an installed runtime may be launched.
 *
 * Every finding is an `error` except a stray patch layer on a non-read-only
 * profile: there the profile already grants write authority, so an extra layer
 * does not cross a trust boundary it was defending. On a read-only profile the
 * same file is fatal — it can mount write and network tools onto a composition
 * whose whole purpose is to lack them.
 */
export function doctorDshRuntime(
  channel: unknown,
  facts: DshInstalledRuntimeFacts,
  profileId: DshProfileId
): DshDoctorReport {
  const findings: DshDoctorFinding[] = []

  const parsed = dshRuntimeChannelSchema.safeParse(channel)
  if (!parsed.success) {
    return {
      healthy: false,
      findings: [
        {
          code: "channel-malformed",
          severity: "error",
          detail: parsed.error.issues.map((issue) => issue.path.join(".") || "(root)").join(", "),
        },
      ],
    }
  }
  const manifest = parsed.data

  if (manifest.lockfileDigest !== facts.lockfileDigest) {
    findings.push({
      code: "lockfile-digest-mismatch",
      severity: "error",
      detail: `expected ${manifest.lockfileDigest}, found ${facts.lockfileDigest}`,
    })
  }

  if (manifest.compositionDigest !== facts.compositionDigest) {
    findings.push({
      code: "composition-digest-mismatch",
      severity: "error",
      detail: `expected ${manifest.compositionDigest}, found ${facts.compositionDigest}`,
    })
  }

  const nodeMajor = parseNodeMajor(facts.nodeVersion)
  if (nodeMajor === undefined || nodeMajor < manifest.nodeMajorRequired) {
    findings.push({
      code: "node-version-unsupported",
      severity: "error",
      detail: `requires Node >= ${manifest.nodeMajorRequired}, found ${facts.nodeVersion}`,
    })
  }

  if (!manifest.platforms.includes(facts.platform as DshPlatform)) {
    findings.push({
      code: "platform-unsupported",
      severity: "error",
      detail: `channel supports ${manifest.platforms.join(", ")}, running on ${facts.platform}`,
    })
  }

  for (const strayPath of facts.strayPatchPaths ?? []) {
    findings.push({
      // Fatal on read-only because such a layer may `insert` plugin rows and run
      // arbitrary JS via `!!js`, after the digests have already verified.
      severity: isReadOnlyProfile(profileId) ? "error" : "warning",
      code: "stray-patch-layer",
      detail: strayPath,
    })
  }

  const profile = findProfile(manifest, profileId)
  if (profile?.requiresNativeSubprocess && facts.hasNativeToolchain === false) {
    findings.push({
      code: "native-toolchain-missing",
      severity: "error",
      // node-pty has no Linux prebuild upstream, so this profile cannot install
      // there without node-gyp. Reported here rather than at spawn time.
      detail: "profile composes a subprocess provider requiring a node-gyp toolchain",
    })
  }

  return { healthy: !findings.some((finding) => finding.severity === "error"), findings }
}

/**
 * Environment variables the runtime subprocess is allowed to inherit.
 *
 * `HarnessClientOptions.env` replaces the child environment wholesale when
 * given, so this list is the entire environment — anything absent is absent.
 * That is the point: it means an API key for some other provider sitting in the
 * parent environment cannot reach a DSH tool process.
 */
const INHERITED_ENV_KEYS = ["PATH", "LANG", "LC_ALL", "TZ", "TMPDIR"] as const

export interface DshLaunchPaths {
  /** Cognia-owned isolated runtime home containing node_modules and the launcher. */
  runtimeHome: string
  /** Absolute path to the launcher (inside `runtimeHome`). */
  launcherPath: string
  /** Absolute path to the profile's composition file. */
  compositionPath: string
  /** Directory DSH treats as its user-data root. Must sit inside `runtimeHome`. */
  dshHome: string
  /** Absolute workspace the agent may read (and, on workspace profiles, write). */
  workspace: string
  /** Where session JSONL is written. */
  sessionRoot: string
}

export interface DshLaunchOptions {
  paths: DshLaunchPaths
  /**
   * Resolved DeepSeek API key.
   *
   * Resolved by the execution host immediately before launch from a
   * `CredentialReference`, and never persisted into the agent config, logs,
   * events, or error messages.
   */
  apiKey: string
  model?: string
  contextWindow?: number
  persona?: string
  /** Parent environment to draw the allowlisted values from. */
  parentEnv: Readonly<Record<string, string | undefined>>
  /** Absolute path to the Node binary. Cognia's bundled Node satisfies DSH. */
  nodePath: string
}

export interface DshLaunchSpec {
  command: string
  args: string[]
  env: Record<string, string>
}

export class DshLaunchConfigurationError extends Error {}

/**
 * Build the subprocess launch spec.
 *
 * @throws {DshLaunchConfigurationError} when `dshHome` is not inside
 * `runtimeHome`. The launcher enforces this too; duplicating it here means a
 * misconfiguration is caught before a process is spawned and before a
 * credential is placed into an environment.
 */
export function buildDshLaunchSpec(options: DshLaunchOptions): DshLaunchSpec {
  const { paths, apiKey, parentEnv, nodePath } = options

  if (!apiKey) {
    throw new DshLaunchConfigurationError("Refusing to launch without a resolved DeepSeek API key.")
  }
  if (!isPathInside(paths.dshHome, paths.runtimeHome)) {
    throw new DshLaunchConfigurationError(
      `DSH_HOME (${paths.dshHome}) must be inside the Cognia runtime home (${paths.runtimeHome}).`
    )
  }

  const env: Record<string, string> = {}
  for (const key of INHERITED_ENV_KEYS) {
    const value = parentEnv[key]
    if (typeof value === "string" && value.length > 0) env[key] = value
  }

  // HOME is redirected into the runtime home so that anything resolving a user
  // profile — including DSH's own `~/.dsh` fallback — lands in Cognia-owned
  // space even if DSH_HOME were somehow dropped.
  env.HOME = paths.runtimeHome
  env.DSH_HOME = paths.dshHome
  env.COGNIA_DSH_RUNTIME_HOME = paths.runtimeHome
  env.COGNIA_DSH_WORKSPACE = paths.workspace
  env.COGNIA_DSH_SESSION_ROOT = paths.sessionRoot
  env.DEEPSEEK_API_KEY = apiKey

  if (options.model) env.COGNIA_DSH_MODEL = options.model
  if (options.contextWindow !== undefined) {
    env.COGNIA_DSH_CONTEXT_WINDOW = String(options.contextWindow)
  }
  if (options.persona) env.COGNIA_DSH_PERSONA = options.persona

  return { command: nodePath, args: [paths.launcherPath, paths.compositionPath], env }
}

/** Path containment on already-normalized absolute paths. */
export function isPathInside(child: string, parent: string): boolean {
  if (child === parent) return true
  // The trailing separator prevents `/a/home-evil` matching parent `/a/home`.
  const separator = parent.includes("\\") && !parent.includes("/") ? "\\" : "/"
  const normalizedParent = parent.endsWith(separator) ? parent : parent + separator
  return child.startsWith(normalizedParent)
}

/**
 * Redact secrets from runtime output before it reaches a log, event, or error.
 *
 * DSH surfaces a bounded stderr tail on transport loss, and a misconfigured
 * composition can echo its environment. Applied to every byte of child stderr
 * Cognia retains.
 */
export function redactDshOutput(text: string, secrets: readonly string[]): string {
  let output = text
  for (const secret of secrets) {
    // Very short values would match far too much; a real key is long.
    if (!secret || secret.length < 8) continue
    output = output.split(secret).join("[redacted]")
  }
  // Belt and braces: catch a key that arrived through a path the caller did not
  // know to pass in.
  return output.replace(/\bsk-[A-Za-z0-9]{16,}\b/g, "[redacted]")
}

/**
 * Capability ids a DSH transport actually supports.
 *
 * `RUNTIME_CAPABILITIES.external` in the execution resolver is a static, static
 * best-case for the whole external adapter family: it grants `session.resume`,
 * `steer`, `set-model`, and `permissions.interrupt-resume`. DSH supports none
 * of those on either transport. Intersecting the static table with this list is
 * what stops the compatibility gate from certifying capabilities the runtime
 * does not have, and stops the UI rendering controls that would do nothing.
 */
export function dshRuntimeCapabilities(snapshot: DshCapabilitySnapshot): string[] {
  const capabilities = ["session.multi-turn", "tools.ordinary", "tools.results", "tools.errors"]
  if (snapshot.streamingDeltas) capabilities.push("streaming")
  // Only ACP can set a mode, and only because it can carry the question.
  if (snapshot.interactiveApproval) capabilities.push("permissions.set-mode")
  if (snapshot.sessionResume) capabilities.push("session.resume")
  return capabilities
}

/** Pinned upstream release this channel certifies. */
export const DSH_UPSTREAM_VERSION = "0.1.0-rc.6"
export const DSH_NODE_MAJOR_REQUIRED = 26 as const
export const DSH_CONFORMANCE_SUITE_VERSION = "1"

/**
 * Build the channel manifest from the digests a host just computed.
 *
 * Shared so the desktop and headless installs certify an *identical* channel.
 * The profile and capability vocabulary lives in TypeScript, which is why the
 * Rust installer stages and returns digests rather than writing the manifest
 * itself — duplicating this table in Rust is how the two would drift.
 */
export function buildDshChannelManifest(digests: {
  lockfileDigest: string
  compositionDigest: string
}): DshRuntimeChannel {
  return {
    schemaVersion: 1,
    // Identity is the composition digest, not the version string: upstream
    // shipped six release candidates in three days.
    channelId: `dsh-${DSH_UPSTREAM_VERSION}-${digests.compositionDigest.slice(0, 8)}`,
    lockfileDigest: digests.lockfileDigest,
    compositionDigest: digests.compositionDigest,
    upstreamVersion: DSH_UPSTREAM_VERSION,
    nodeMajorRequired: DSH_NODE_MAJOR_REQUIRED,
    platforms: ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"],
    profiles: [
      {
        profileId: "cognia-sdk-readonly",
        compositionFile: "host.sdk-readonly.yml",
        capabilities: DSH_SDK_CAPABILITIES,
        requiresNativeSubprocess: false,
      },
      {
        profileId: "cognia-sdk-workspace",
        compositionFile: "host.sdk-workspace.yml",
        capabilities: DSH_SDK_CAPABILITIES,
        // node-pty has no Linux prebuild upstream.
        requiresNativeSubprocess: true,
      },
      {
        profileId: "cognia-acp",
        compositionFile: "host.acp.yml",
        capabilities: DSH_ACP_CAPABILITIES,
        requiresNativeSubprocess: false,
      },
    ],
    conformanceSuiteVersion: DSH_CONFORMANCE_SUITE_VERSION,
    // Upstream is a developer preview promising breaking changes.
    experimental: true,
  }
}

/**
 * Whether a profile may run without a human watching.
 *
 * True only for the read-only profile, whose guarantee rests on composing no
 * approval provider. Workspace profiles grant authority at launch that cannot
 * be revoked mid-turn on this transport.
 */
export function isUnattendedSafeProfile(profileId: DshProfileId): boolean {
  return isReadOnlyProfile(profileId) && profileTransport(profileId) === "dsh-sdk"
}
