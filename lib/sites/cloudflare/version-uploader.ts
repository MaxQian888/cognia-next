import { isTauri } from "@/lib/tauri"
import { isPathUnderRoot } from "@/lib/sandbox/policy-bridge"
import { assertApprovedSiteProviderTool } from "@/lib/sites/approved-tool"
import { hasNoLeakingPiiDeep } from "@cognia/redact"

interface NativeSandboxResult {
  exit_code: number
  stdout: string
  stderr: string
  duration: number
  timed_out: boolean
}

export interface CloudflareVersionUploadInput {
  wranglerBinaryPath: string
  stagingRoot: string
  configPath: string
  entryPath: string
  assetsPath?: string
  workerName: string
  accountId: string
  apiToken: string
  tag: string
  message: string
  compatibilityDate: string
  compatibilityFlags: string[]
}

export interface CloudflareVersionUploadResult {
  exitCode: number
  stdout: string
  stderr: string
  durationSeconds: number
  timedOut: boolean
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(value)
}

function parentPath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/, "")
  const index = normalized.lastIndexOf("/")
  return index <= 0 ? normalized.slice(0, Math.max(index, 1)) : normalized.slice(0, index)
}

function cleanOutput(value: string): string {
  const maxBytes = 1024 * 1024
  const bytes = new TextEncoder().encode(value)
  return bytes.byteLength <= maxBytes ? value : new TextDecoder().decode(bytes.slice(0, maxBytes))
}

function childPath(parent: string, name: string): string {
  const separator = parent.includes("\\") && !parent.includes("/") ? "\\" : "/"
  return `${parent.replace(/[\\/]+$/, "")}${separator}${name}`
}

async function readTextAssets(root: string): Promise<string[]> {
  const fs = await import("@tauri-apps/plugin-fs")
  const contents: string[] = []
  const visit = async (dir: string): Promise<void> => {
    for (const entry of await fs.readDir(dir)) {
      const path = childPath(dir, entry.name)
      if (entry.isDirectory) {
        await visit(path)
        continue
      }
      if (!entry.isFile) continue
      const bytes = await fs.readFile(path)
      try {
        contents.push(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
      } catch {
        // Binary assets are not model-readable text and cannot contain a recognized text PII shape.
      }
    }
  }
  await visit(root)
  return contents
}

async function assertUploadPayloadPiiSafe(input: CloudflareVersionUploadInput): Promise<void> {
  const fs = await import("@tauri-apps/plugin-fs")
  const textualPayload = {
    entry: await fs.readTextFile(input.entryPath),
    config: await fs.readTextFile(input.configPath),
    assets: input.assetsPath ? await readTextAssets(input.assetsPath) : [],
    workerName: input.workerName,
    accountId: input.accountId,
    tag: input.tag,
    message: input.message,
    compatibilityFlags: input.compatibilityFlags,
  }
  if (!hasNoLeakingPiiDeep(textualPayload)) {
    throw new Error("Cloudflare upload payload failed the outbound PII gate")
  }
}

/**
 * Upload a pre-built Worker as a saved Cloudflare Version without deploying.
 *
 * This is intentionally separate from untrusted build execution. The provider
 * token is available only to a direct, absolute Wrangler binary running in the
 * existing fail-closed sandbox, against a Cognia-generated JSON config, with
 * egress restricted to Cloudflare's API.
 */
export async function uploadCloudflareWorkerVersion(
  input: CloudflareVersionUploadInput
): Promise<CloudflareVersionUploadResult> {
  if (!isTauri()) throw new Error("Cloudflare version upload requires the local Tauri host")
  for (const [label, path] of [
    ["Wrangler binary", input.wranglerBinaryPath],
    ["staging root", input.stagingRoot],
    ["config", input.configPath],
    ["entry", input.entryPath],
    ...(input.assetsPath ? [["assets", input.assetsPath] as const] : []),
  ] as const) {
    if (!isAbsolutePath(path)) throw new Error(`${label} path must be absolute`)
  }
  if (!isPathUnderRoot(input.configPath, input.stagingRoot)) {
    throw new Error("Cloudflare Wrangler config must stay inside the Sites staging root")
  }
  if (!input.apiToken.trim()) throw new Error("Cloudflare API token is required")
  await assertApprovedSiteProviderTool(input.wranglerBinaryPath)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(input.tag)) {
    throw new Error("Cloudflare version tag is invalid")
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.compatibilityDate)) {
    throw new Error("Cloudflare compatibility date must use YYYY-MM-DD")
  }
  await assertUploadPayloadPiiSafe(input)
  const argv = [
    input.wranglerBinaryPath,
    "versions",
    "upload",
    input.entryPath,
    "--config",
    input.configPath,
    "--name",
    input.workerName,
    "--no-bundle",
    "--tag",
    input.tag,
    "--message",
    input.message,
    "--compatibility-date",
    input.compatibilityDate,
  ]
  for (const flag of input.compatibilityFlags) {
    argv.push("--compatibility-flag", flag)
  }
  if (input.assetsPath) argv.push("--assets", input.assetsPath)

  const readable = [
    parentPath(input.wranglerBinaryPath),
    parentPath(input.entryPath),
    ...(input.assetsPath ? [input.assetsPath] : []),
  ]
  const { invoke } = await import("@tauri-apps/api/core")
  const result = await invoke<NativeSandboxResult>("sandbox_exec", {
    tool: "sandbox_bash",
    command: {
      argv,
      cwd: input.stagingRoot,
      env: {
        CLOUDFLARE_API_TOKEN: input.apiToken,
        CLOUDFLARE_ACCOUNT_ID: input.accountId,
        WRANGLER_SEND_METRICS: "false",
      },
      stdin: null,
      timeout: 300,
    },
    request: {
      writable: [input.stagingRoot],
      readable,
      targetFiles: [],
      maxCpuSeconds: 300,
      maxMemoryMb: 2048,
      network: "allowlist",
      networkHosts: ["api.cloudflare.com"],
    },
  })
  return {
    exitCode: result.exit_code,
    stdout: cleanOutput(result.stdout),
    stderr: cleanOutput(result.stderr),
    durationSeconds: result.duration,
    timedOut: result.timed_out,
  }
}
