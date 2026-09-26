// Command policy for the allowlist-gated shell tools (`shell_execute_advanced`,
// `start_process`) and the destructive-chaining scan every shell tool runs.
// Mirrored verbatim from `D:\Project\Cognia\lib\ai\tools\shell-tool.ts:60-136`.

/**
 * Commands explicitly blocked because they're destructive enough that the
 * user almost never wants them invoked from chat. Lifted verbatim from
 * Cognia's shell-tool.ts:111-124.
 */
export const BLOCKED_COMMANDS: ReadonlySet<string> = new Set([
  // Deletion — use directory_delete (with approval) instead.
  "rm",
  "rmdir",
  "del",
  "erase",
  // Disk operations.
  "format",
  "fdisk",
  "mkfs",
  // System control.
  "shutdown",
  "reboot",
  "halt",
  "poweroff",
  // User management.
  "passwd",
  "useradd",
  "userdel",
  "usermod",
  // Permission changes.
  "chmod",
  "chown",
  "chgrp",
  // Raw disk write.
  "dd",
  // Swap management.
  "mkswap",
  "swapon",
  "swapoff",
  // Mount operations.
  "mount",
  "umount",
  // Firewall.
  "iptables",
  "firewall-cmd",
  "ufw",
  // Service management.
  "systemctl",
  "service",
  // Cron.
  "crontab",
  // Windows registry.
  "reg",
  "regedit",
])

/**
 * Read-only / development-friendly commands that are explicitly allowed
 * without further checks beyond the dangerous-pattern scan. Lifted from
 * shell-tool.ts:60-106 with the destructive items pruned (rm, del, etc are
 * in BLOCKED_COMMANDS even if they would otherwise pass).
 */
export const ALLOWED_COMMANDS: ReadonlySet<string> = new Set([
  // File browsing.
  "ls",
  "dir",
  "find",
  "tree",
  "cat",
  "head",
  "tail",
  "wc",
  "file",
  "stat",
  "du",
  "df",
  "which",
  "where",
  "whereis",
  "type",
  // Text processing.
  "grep",
  "rg",
  "ag",
  "awk",
  "sed",
  "sort",
  "uniq",
  "cut",
  "tr",
  "diff",
  "comm",
  "strings",
  "hexdump",
  "xxd",
  // Version control.
  "git",
  "svn",
  "gh",
  "hg",
  // Package managers & runners.
  "npm",
  "npx",
  "pnpm",
  "pnpx",
  "yarn",
  "bun",
  "bunx",
  "pip",
  "pip3",
  "pipx",
  "uv",
  "cargo",
  "go",
  "composer",
  "gem",
  "dotnet",
  "mvn",
  "gradle",
  "deno",
  "proto",
  // Development tools.
  "node",
  "python",
  "python3",
  "ruby",
  "java",
  "javac",
  "rustc",
  "gcc",
  "g++",
  "clang",
  "make",
  "cmake",
  "tsc",
  "eslint",
  "prettier",
  "jest",
  "vitest",
  "playwright",
  "swift",
  "swiftc",
  "kotlin",
  "kotlinc",
  // Mobile & cross-platform.
  "flutter",
  "dart",
  "expo",
  "react-native",
  // Linters & formatters.
  "ruff",
  "black",
  "mypy",
  "flake8",
  "pylint",
  "isort",
  "clippy",
  "rustfmt",
  "gofmt",
  "golint",
  "golangci-lint",
  "biome",
  "oxlint",
  "dprint",
  // System info.
  "uname",
  "hostname",
  "whoami",
  "id",
  "env",
  "printenv",
  "date",
  "uptime",
  "free",
  "top",
  "htop",
  "ps",
  "echo",
  // Network read-only.
  "ping",
  "curl",
  "wget",
  "dig",
  "nslookup",
  "traceroute",
  "tracert",
  "netstat",
  "ss",
  "ifconfig",
  "ip",
  // Archive read.
  "tar",
  "zip",
  "unzip",
  "gzip",
  "gunzip",
  "7z",
  // Windows specific.
  "cmd",
  "powershell",
  "pwsh",
  "systeminfo",
  "tasklist",
  "ipconfig",
  // Containers.
  "docker",
  "docker-compose",
  "podman",
  // DevOps & cloud.
  "terraform",
  "kubectl",
  "helm",
  "ansible",
  "vagrant",
  "aws",
  "az",
  "gcloud",
  "heroku",
  "vercel",
  "netlify",
  // Media.
  "ffmpeg",
  "ffprobe",
  "magick",
  "convert",
  "identify",
  // Database clients.
  "psql",
  "mysql",
  "sqlite3",
  "mongosh",
  "redis-cli",
])

/**
 * Patterns whose presence in the args is an immediate reject — they indicate
 * shell injection or chaining toward a destructive command. Mirrors
 * shell-tool.ts:129-136.
 */
export const DANGEROUS_PATTERNS: readonly RegExp[] = [
  /;\s*(rm|rmdir|del|erase|format|shutdown|reboot|halt|poweroff)\b/i,
  /\|\s*(rm|rmdir|del|format|shutdown|reboot)\b/i,
  />\s*\/dev\//i,
  /&&\s*(rm|rmdir|del|format|shutdown|reboot)\b/i,
  /`[^`]*(rm|rmdir|del|format|shutdown|reboot)[^`]*`/i,
  /\$\([^)]*(rm|rmdir|del|format|shutdown|reboot)[^)]*\)/i,
]
