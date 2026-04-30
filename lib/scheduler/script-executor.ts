/**
 * Script executor for scheduled tasks. Cognia originally routed scripts
 * through a Pyodide/Docker sandbox; cognia-next has no sandbox runtime, so
 * we shell out to the host interpreter via the existing `shell_exec` Tauri
 * command. The validator and language list mirror Cognia so the existing UI
 * (script-task-editor, system-task-form) keeps working unchanged.
 */

import { invoke } from "@tauri-apps/api/core"
import { isTauri } from "@/lib/tauri"
import type { ExecuteScriptAction, TaskRunResult } from "@/types/scheduler"

interface ShellResult {
  stdout: string
  stderr: string
  exit_code: number | null
  timed_out: boolean
  stdout_truncated: boolean
  stderr_truncated: boolean
}

/**
 * Wrap inline script source into a shell command that pipes the body to the
 * appropriate interpreter via stdin. Avoids touching the filesystem so we
 * don't have to garbage-collect temp files; tradeoff is interpreters that
 * can't read from stdin won't work (none of the supported languages here
 * have that limitation).
 */
function buildScriptCommand(action: ExecuteScriptAction): string | null {
  const language = action.language.toLowerCase()
  const code = action.code

  // base64-encode the script body so we can pass arbitrary content (newlines,
  // quotes, special chars) through the cmd.exe / sh -c layer without
  // hand-rolling per-shell escaping. The decode side is a one-liner in each
  // interpreter.
  const b64 = Buffer.from(code, "utf-8").toString("base64")

  switch (language) {
    case "python":
    case "python3":
      return `python -c "import base64; exec(base64.b64decode('${b64}').decode('utf-8'))"`

    case "javascript":
    case "js":
    case "node":
      return `node -e "eval(Buffer.from('${b64}', 'base64').toString('utf-8'))"`

    case "typescript":
    case "ts":
      // Requires `tsx` or `ts-node` on PATH; fall back to running as JS if the
      // user just wants to evaluate TypeScript that's also valid JS.
      return `npx --yes tsx -e "${code.replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`

    case "bash":
    case "sh":
    case "shell":
      return `echo ${b64} | base64 -d | bash`

    case "powershell":
    case "pwsh":
      // PowerShell has its own -EncodedCommand flag; expects UTF-16LE base64.
      const utf16 = Buffer.from(code, "utf16le").toString("base64")
      return `powershell -EncodedCommand ${utf16}`

    case "ruby":
      return `ruby -e "$(echo ${b64} | base64 -d)"`

    case "go":
    case "rust":
      // Compiled languages — no inline `eval` mode. Caller should use the
      // system scheduler "run command" action with a pre-built binary.
      return null

    default:
      return null
  }
}

export async function executeScript(action: ExecuteScriptAction): Promise<TaskRunResult> {
  if (!isTauri()) {
    return { success: false, error: "Script execution requires Tauri (desktop) runtime" }
  }

  const command = buildScriptCommand(action)
  if (!command) {
    return {
      success: false,
      error: `Unsupported script language for inline execution: ${action.language}`,
    }
  }

  const cwd =
    action.working_dir || (typeof process !== "undefined" ? (process.cwd?.() ?? ".") : ".")
  const timeout_secs = Math.max(1, Math.min(action.timeout_secs ?? 300, 300))

  const start = Date.now()
  try {
    const result = await invoke<ShellResult>("shell_exec", {
      cmd: command,
      cwd,
      timeoutSecs: timeout_secs,
    })

    const duration = Date.now() - start
    const success = !result.timed_out && (result.exit_code === 0 || result.exit_code === null)

    return {
      success,
      exit_code: result.exit_code ?? undefined,
      stdout: result.stdout || undefined,
      stderr: result.stderr || undefined,
      error: result.timed_out
        ? `Script timed out after ${timeout_secs}s`
        : success
          ? undefined
          : `Script exited with code ${result.exit_code}`,
      duration_ms: duration,
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      duration_ms: Date.now() - start,
    }
  }
}

/**
 * Validate script before execution. Mirrors Cognia's heuristics so the form
 * UI shows the same warnings — these are guardrails, not security controls.
 */
export function validateScript(
  language: string,
  code: string
): { valid: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []

  if (!code.trim()) errors.push("Script code cannot be empty")
  if (!language) errors.push("Script language must be specified")

  for (const pattern of getDangerousPatterns(language)) {
    if (pattern.regex.test(code)) {
      ;(pattern.severity === "error" ? errors : warnings).push(pattern.message)
    }
  }

  if (code.length > 1024 * 1024) errors.push("Script exceeds maximum size (1MB)")

  return { valid: errors.length === 0, errors, warnings }
}

interface DangerousPattern {
  regex: RegExp
  message: string
  severity: "error" | "warning"
}

function getDangerousPatterns(language: string): DangerousPattern[] {
  const common: DangerousPattern[] = [
    {
      regex: /rm\s+-rf\s+[\/\\]/i,
      message: "检测到危险的文件删除命令 / Dangerous file deletion command detected",
      severity: "error",
    },
    {
      regex: /format\s+[a-z]:/i,
      message: "检测到格式化磁盘命令 / Disk format command detected",
      severity: "error",
    },
  ]

  const pythonPatterns: DangerousPattern[] = [
    { regex: /os\.system\s*\(/, message: "使用 os.system 可能存在安全风险", severity: "warning" },
    {
      regex: /subprocess\.(call|run|Popen)\s*\(/,
      message: "使用 subprocess 需谨慎",
      severity: "warning",
    },
    { regex: /eval\s*\(/, message: "避免使用 eval", severity: "warning" },
    { regex: /exec\s*\(/, message: "避免使用 exec", severity: "warning" },
  ]

  const jsPatterns: DangerousPattern[] = [
    { regex: /eval\s*\(/, message: "避免使用 eval", severity: "warning" },
    { regex: /new\s+Function\s*\(/, message: "避免使用 Function 构造器", severity: "warning" },
  ]

  const shellPatterns: DangerousPattern[] = [
    { regex: /:\s*\(\)\s*{\s*:\s*\|/, message: "检测到 Fork 炸弹", severity: "error" },
    { regex: />\s*\/dev\/sd[a-z]/, message: "检测到直接写入磁盘", severity: "error" },
  ]

  switch (language.toLowerCase()) {
    case "python":
    case "python3":
      return [...common, ...pythonPatterns]
    case "javascript":
    case "typescript":
    case "js":
    case "ts":
      return [...common, ...jsPatterns]
    case "bash":
    case "shell":
    case "sh":
    case "powershell":
    case "pwsh":
      return [...common, ...shellPatterns]
    default:
      return common
  }
}

export function getScriptTemplate(language: string): string {
  switch (language.toLowerCase()) {
    case "python":
    case "python3":
      return `# Scheduled task script\nprint("Hello from scheduled task!")\n`
    case "javascript":
    case "js":
      return `// Scheduled task script\nconsole.log("Hello from scheduled task!")\n`
    case "typescript":
    case "ts":
      return `// Scheduled task script\nconsole.log("Hello from scheduled task!")\n`
    case "bash":
    case "sh":
    case "shell":
      return `#!/bin/bash\nset -e\necho "Hello from scheduled task!"\n`
    case "powershell":
    case "pwsh":
      return `Write-Host "Hello from scheduled task!"\n`
    case "ruby":
      return `puts "Hello from scheduled task!"\n`
    default:
      return ""
  }
}

export function getSupportedLanguages(): string[] {
  return ["python", "javascript", "typescript", "bash", "powershell", "ruby"]
}
