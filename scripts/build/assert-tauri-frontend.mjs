import { access, readFile } from "node:fs/promises"
import path from "node:path"

const output = path.resolve(process.argv[2] ?? "out")
const marker = path.join(output, ".cognia-profile.json")

try {
  await access(marker)
  const detail = await readFile(marker, "utf8")
  throw new Error(`Tauri packaging rejected a profiling frontend at ${output}: ${detail.trim()}`)
} catch (error) {
  if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
    process.stdout.write(`Tauri frontend accepted: ${output}\n`)
  } else {
    throw error
  }
}
