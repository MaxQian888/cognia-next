import type { ExternalAgentConfig } from "@/types/agent/external-agent"
import type { ExternalAgentLifecycleFields } from "@/types/agent/external-agent-lifecycle"
import { dshRuntimeChannelSchema, type DshProfileId } from "@/types/agent/dsh-runtime-channel"
import { agentInvoke } from "./agent-transport"
import {
  buildDshLaunchSpec,
  doctorDshRuntime,
  findProfile,
  type DshInstalledRuntimeFacts,
} from "./dsh-runtime-install"

interface ManagedLaunchFacts extends DshInstalledRuntimeFacts {
  manifestJson: string | null
  runtimeHome: string
  nodePath: string
  defaultWorkspace: string
  parentEnv: Record<string, string>
}

/** Resolve both DSH transports from the installed channel immediately before connect.
 * This returns a transient config: neither runtime paths nor credentials are saved.
 */
export async function prepareDshManagedLaunch(
  config: ExternalAgentConfig
): Promise<ExternalAgentConfig> {
  const profileId = config.metadata?.dshProfileId
  if (profileId === undefined) return config
  if (!["cognia-sdk-readonly", "cognia-sdk-workspace", "cognia-acp"].includes(String(profileId))) {
    throw new Error("Unknown DeepSeek Harness runtime profile")
  }
  const facts = await agentInvoke<ManagedLaunchFacts>("dsh_runtime_facts", {})
  let manifest: unknown
  try {
    manifest = JSON.parse(facts.manifestJson ?? "null")
  } catch {
    manifest = null
  }
  const report = doctorDshRuntime(manifest, facts, profileId as DshProfileId)
  if (!report.healthy) {
    throw new Error(
      `DeepSeek Harness runtime needs repair: ${report.findings.map((finding) => finding.code).join(", ")}`
    )
  }
  const profile = findProfile(dshRuntimeChannelSchema.parse(manifest), profileId as DshProfileId)
  if (!profile || profile.capabilities.transport !== config.protocol) {
    throw new Error("DeepSeek Harness profile does not match the configured protocol")
  }
  const workspace = config.process?.cwd?.trim() || facts.defaultWorkspace
  if (!facts.runtimeHome || !facts.nodePath || !workspace) {
    throw new Error("DeepSeek Harness host did not provide launch paths; update the host")
  }
  const separator = facts.runtimeHome.includes("\\") ? "\\" : "/"
  const join = (name: string) => `${facts.runtimeHome}${separator}${name}`
  const launchEnv = config.process?.env ?? {}
  let gateway: { config: string; token: string; taskConfig: string; taskToken: string } | undefined
  if (config.metadata?.cogniaGatewayTask !== undefined) {
    let task: { taskId?: unknown; runtime?: unknown }
    try {
      task = JSON.parse(launchEnv.COGNIA_GATEWAY_TASK_CONFIG ?? "null")
    } catch {
      task = {}
    }
    if (
      !task ||
      task.runtime !== "dsh" ||
      task.taskId !== config.metadata.cogniaGatewayTask ||
      !launchEnv.COGNIA_DSH_GATEWAY_CONFIG ||
      !launchEnv.COGNIA_DSH_GATEWAY_TOKEN ||
      !launchEnv.COGNIA_GATEWAY_TOKEN
    ) {
      throw new Error("DeepSeek Harness Cognia model route is missing its task-scoped lease")
    }
    gateway = {
      config: launchEnv.COGNIA_DSH_GATEWAY_CONFIG,
      token: launchEnv.COGNIA_DSH_GATEWAY_TOKEN,
      taskConfig: launchEnv.COGNIA_GATEWAY_TASK_CONFIG,
      taskToken: launchEnv.COGNIA_GATEWAY_TOKEN,
    }
  }
  let apiKey = gateway ? undefined : launchEnv.DEEPSEEK_API_KEY
  if (!apiKey && !gateway) {
    const { getExternalAgentLifecycleService } = await import("./lifecycle/service")
    const lifecycle = await getExternalAgentLifecycleService()
    const secrets = await lifecycle.readSecrets(
      config as ExternalAgentConfig & ExternalAgentLifecycleFields
    )
    apiKey = secrets.processEnv?.DEEPSEEK_API_KEY
  }
  const positiveInteger = (key: string): number | undefined => {
    const value = launchEnv[key]
    if (value === undefined) return undefined
    const number = Number(value)
    if (!value.trim() || !Number.isSafeInteger(number) || number <= 0) {
      throw new Error(`DeepSeek Harness ${key} must be a positive safe integer`)
    }
    return number
  }
  const spec = buildDshLaunchSpec({
    paths: {
      runtimeHome: facts.runtimeHome,
      launcherPath: join("launcher.mjs"),
      compositionPath: join(profile.compositionFile),
      dshHome: join("dsh-home"),
      sessionRoot: join("sessions"),
      workspace,
    },
    nodePath: facts.nodePath,
    parentEnv: facts.parentEnv,
    apiKey: apiKey ?? "",
    gateway,
    provider: launchEnv.COGNIA_DSH_PROVIDER,
    model: launchEnv.COGNIA_DSH_MODEL,
    baseUrl: launchEnv.DEEPSEEK_BASE_URL,
    reasoningEffort: launchEnv.COGNIA_DSH_REASONING_EFFORT,
    maxTokens: positiveInteger("COGNIA_DSH_MAX_TOKENS"),
    contextWindow: positiveInteger("COGNIA_DSH_CONTEXT_WINDOW"),
    persona: launchEnv.COGNIA_DSH_PERSONA,
  })
  return { ...config, process: { ...spec, cwd: workspace } }
}
