import { spawn } from "node:child_process"
import { access, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"

const root = process.cwd()
const normalOut = path.join(root, "out")
const profileOut = path.join(root, "out-profile")
const preservedOut = path.join(root, `.out-normal-${process.pid}`)

async function exists(target) {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

async function runProfileBuild() {
  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm"
  await new Promise((resolve, reject) => {
    const child = spawn(command, ["exec", "next", "build", "--webpack", "--profile"], {
      cwd: root,
      stdio: "inherit",
      env: {
        ...process.env,
        NODE_OPTIONS: process.env.NODE_OPTIONS ?? "--max-old-space-size=16384",
        NEXT_PUBLIC_COGNIA_PROFILE_BUILD: "1",
      },
    })
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`profiling build failed (${signal ?? code})`))
    })
  })
}

const hadNormalOut = await exists(normalOut)
if (hadNormalOut) await rename(normalOut, preservedOut)

try {
  await runProfileBuild()
  await rm(profileOut, { recursive: true, force: true })
  await rename(normalOut, profileOut)
  await writeFile(
    path.join(profileOut, ".cognia-profile.json"),
    `${JSON.stringify({ profile: "profiling", createdAt: new Date().toISOString() })}\n`,
    "utf8"
  )
} finally {
  if (await exists(normalOut)) await rm(normalOut, { recursive: true, force: true })
  if (hadNormalOut && (await exists(preservedOut))) await rename(preservedOut, normalOut)
}
