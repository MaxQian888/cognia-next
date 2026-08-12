import { execFile } from "node:child_process"

const CHOOSE_FOLDER_SCRIPT = `use scripting additions
set selectedFolder to choose folder with prompt "Choose one folder to attach"
return POSIX path of selectedFolder`

function runCommand(command, args, options) {
  return new Promise((resolveResult) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      resolveResult({
        ok: error == null,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
        error: error?.message ?? null,
      })
    })
  })
}

export async function selectNativeFolder(dependencies = {}) {
  const commandRunner = dependencies.commandRunner ?? runCommand
  const result = await commandRunner("/usr/bin/osascript", ["-e", CHOOSE_FOLDER_SCRIPT], {
    timeout: dependencies.timeoutMs ?? 300_000,
  })
  if (!result.ok) {
    if (/\(-128\)|User canceled/iu.test(result.stderr || result.error || "")) return null
    throw new Error(result.stderr || result.error || "Unable to select a folder")
  }
  const selected = String(result.stdout ?? "").trim()
  if (!selected) throw new Error("Folder selection returned an empty path")
  return selected === "/" ? selected : selected.replace(/\/+$/u, "")
}
