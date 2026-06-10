/**
 * Per-session skill enablement, persisted to `~/.cognia/skill-state.json` as
 * `{ "enabled": ["id", …] }`. Skills are opt-in: only ids listed here are
 * threaded into the build-options `ephemeralSkillIds` seam so their content is
 * appended to the system prompt.
 */
import nodeFs from "node:fs"
import path from "node:path"

export interface SkillStateFs {
  exists(path: string): boolean
  readText(path: string): string
  writeText(path: string, data: string): void
}

const defaultFs: SkillStateFs = {
  exists: (p) => nodeFs.existsSync(p),
  readText: (p) => nodeFs.readFileSync(p, "utf8"),
  writeText: (p, data) => {
    nodeFs.mkdirSync(path.dirname(p), { recursive: true })
    nodeFs.writeFileSync(p, data, "utf8")
  },
}

export function skillStatePath(home: string): string {
  return path.join(home, "skill-state.json")
}

export function readEnabled(home: string, fs: SkillStateFs = defaultFs): Set<string> {
  const file = skillStatePath(home)
  if (!fs.exists(file)) return new Set()
  try {
    const parsed = JSON.parse(fs.readText(file)) as { enabled?: unknown }
    if (Array.isArray(parsed.enabled)) {
      return new Set(parsed.enabled.filter((n): n is string => typeof n === "string"))
    }
  } catch {
    // corrupt → empty
  }
  return new Set()
}

export function writeEnabled(
  home: string,
  enabled: Set<string>,
  fs: SkillStateFs = defaultFs
): void {
  fs.writeText(skillStatePath(home), JSON.stringify({ enabled: [...enabled] }, null, 2))
}

/** Flip a skill's enabled state and persist. Returns the new enabled set. */
export function setEnabled(
  home: string,
  id: string,
  enabled: boolean,
  fs: SkillStateFs = defaultFs
): Set<string> {
  const set = readEnabled(home, fs)
  if (enabled) set.add(id)
  else set.delete(id)
  writeEnabled(home, set, fs)
  return set
}
