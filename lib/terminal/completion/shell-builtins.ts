/**
 * Static shell-builtin command lists for the exe completion provider
 * (ADR-0039 phase 2). These are commands the PATH scan can never find —
 * they live inside the shell — so they're merged into head-word
 * completion from these curated lists. Web-safe (no fs, no Tauri).
 *
 * Deliberately "common subset" rather than exhaustive: completion wants
 * the builtins people actually type, not the full POSIX special-builtin
 * taxonomy.
 */

import type { ShellKind } from "@/lib/terminal/shell-detect"

const POSIX_COMMON = [
  "alias",
  "bg",
  "cd",
  "command",
  "echo",
  "eval",
  "exec",
  "exit",
  "export",
  "fg",
  "history",
  "jobs",
  "kill",
  "printf",
  "pwd",
  "read",
  "set",
  "source",
  "test",
  "trap",
  "type",
  "ulimit",
  "umask",
  "unalias",
  "unset",
  "wait",
]

const BASH_ZSH_EXTRA = [
  "bind",
  "builtin",
  "caller",
  "declare",
  "dirs",
  "disown",
  "help",
  "let",
  "local",
  "popd",
  "pushd",
  "shopt",
  "time",
  "times",
]

/** PowerShell: a pragmatic mix of core cmdlets + default aliases. */
const POWERSHELL = [
  "cd",
  "clear",
  "Clear-Host",
  "Copy-Item",
  "echo",
  "Format-List",
  "Format-Table",
  "Get-ChildItem",
  "Get-Command",
  "Get-Content",
  "Get-Help",
  "Get-Item",
  "Get-Location",
  "Get-Member",
  "Get-Process",
  "Get-Service",
  "Invoke-RestMethod",
  "Invoke-WebRequest",
  "ls",
  "Measure-Object",
  "Move-Item",
  "New-Item",
  "Out-File",
  "pwd",
  "Remove-Item",
  "Rename-Item",
  "Select-Object",
  "Select-String",
  "Set-Content",
  "Set-Location",
  "Sort-Object",
  "Start-Process",
  "Stop-Process",
  "Test-Path",
  "Where-Object",
  "Write-Host",
  "Write-Output",
]

const CMD = [
  "cd",
  "cls",
  "copy",
  "del",
  "dir",
  "echo",
  "exit",
  "for",
  "if",
  "md",
  "mkdir",
  "move",
  "path",
  "rd",
  "ren",
  "rmdir",
  "set",
  "setlocal",
  "start",
  "title",
  "type",
  "ver",
  "where",
]

const FISH_EXTRA = [
  "abbr",
  "argparse",
  "begin",
  "block",
  "breakpoint",
  "commandline",
  "contains",
  "count",
  "fish_config",
  "funced",
  "funcsave",
  "functions",
  "math",
  "set_color",
  "string",
]

const NU = [
  "alias",
  "cd",
  "each",
  "echo",
  "exit",
  "first",
  "get",
  "help",
  "history",
  "last",
  "lines",
  "ls",
  "open",
  "par-each",
  "reduce",
  "select",
  "sort-by",
  "str",
  "table",
  "to",
  "uniq",
  "where",
]

/** Builtin command names for one shell family (sorted, deduped). */
export function shellBuiltins(shell: ShellKind): string[] {
  let list: string[]
  switch (shell) {
    case "bash":
    case "zsh":
      list = [...POSIX_COMMON, ...BASH_ZSH_EXTRA]
      break
    case "sh":
      list = [...POSIX_COMMON]
      break
    case "fish":
      list = [...POSIX_COMMON, ...FISH_EXTRA]
      break
    case "pwsh":
    case "powershell":
      list = [...POWERSHELL]
      break
    case "cmd":
      list = [...CMD]
      break
    case "nu":
      list = [...NU]
      break
    default:
      list = []
  }
  return Array.from(new Set(list)).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
}
