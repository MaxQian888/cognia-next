import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import {
  BUILTIN_ROLE_PROFILE,
  CUSTOM_ROLE_PROMPT_VERSION,
  ROLE_PROMPT_FILES,
  ROLE_PROMPT_VERSION,
  ROLE_PROMPTS,
  customRolePromptVersion,
  isMaterializedCustomRoleVersion,
  materializeCustomRoleProfile,
  systemPromptFor,
  type RolePromptName,
} from "./roles"

/** SHA-256 of each prompt as the spec bundle's MANIFEST.sha256 lists it. */
const MANIFEST: Record<string, string> = {
  "00_common.md": "bfc44ff6d15a399376e90af3670c86e10cd328dd83de3297faf724640d4119d4",
  "01_classifier.md": "38474cbcaf9e99263a97a4f4579f31ab597c9c93b6419bc5aa0236d6fac560ca",
  "02_panel_member.md": "0eacc0aa592770964c60fd4f8a9ceb2d2a972fa3feec3340e994bca1e73ee200",
  "03_judge.md": "a2648d2ea5c69abd3a824513d6287191d32c7c819b4038adc63094f7e364ec87",
  "04_synthesizer.md": "4b68166c83b27bb91b1e329969a44b86a19e9598857707b8a9c6ece617611eed",
  "05_lead.md": "f17296a79a0112ae3ccbe60f5c77f7d54f228c8656ed40cb51c160fcfe079e58",
  "06_worker.md": "6f077e48a0077039fa9b3dfea884258793d1f18f4bdb9e552fb62ee4748fddfc",
  "07_reviewer.md": "dc6c613decac899d8881f1a26c812b2065dbc32960d602c2d6b47212e0200b19",
  "08_compactor.md": "0994c03309ceae5bb487562d67e89898578c993d34cdc06d5b82158eefda3a0e",
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex")

describe("role prompts", () => {
  it.each(Object.entries(ROLE_PROMPT_FILES))("embeds %s byte for byte", (name, file) => {
    const vendored = readFileSync(join(__dirname, file), "utf8")
    const embedded = ROLE_PROMPTS[name as keyof typeof ROLE_PROMPTS]
    expect(embedded).toBe(vendored)
    expect(sha256(embedded)).toBe(MANIFEST[file])
  })

  it("covers every prompt the spec ships", () => {
    expect(Object.values(ROLE_PROMPT_FILES).sort()).toEqual(Object.keys(MANIFEST).sort())
  })

  it("names the version the built-in catalog pins", () => {
    expect(ROLE_PROMPT_VERSION).toBe("roles-1")
    expect(ROLE_PROMPTS.panel_member).toContain(ROLE_PROMPT_VERSION)
  })

  it("puts the common constraints first, so every role shares one stable prefix", () => {
    const judge = systemPromptFor("judge")
    const member = systemPromptFor("panel_member")
    expect(judge.startsWith(ROLE_PROMPTS.common)).toBe(true)
    expect(member.startsWith(ROLE_PROMPTS.common)).toBe(true)
    expect(judge.endsWith(ROLE_PROMPTS.judge)).toBe(true)
    expect(systemPromptFor("judge")).toBe(judge)
  })

  it("ships roles-1 as the built-in profile, byte for byte", () => {
    expect(BUILTIN_ROLE_PROFILE.version).toBe(ROLE_PROMPT_VERSION)
    expect(BUILTIN_ROLE_PROFILE.prompts).toBe(ROLE_PROMPTS)
    for (const role of Object.keys(ROLE_PROMPT_FILES) as RolePromptName[]) {
      if (role === "common") continue
      expect(systemPromptFor(role, BUILTIN_ROLE_PROFILE)).toBe(systemPromptFor(role))
      expect(systemPromptFor(role)).toBe(`${ROLE_PROMPTS.common}\n${ROLE_PROMPTS[role]}`)
    }
  })
})

describe("custom role prompt profiles", () => {
  const edited = (judge: string): Record<RolePromptName, string> => ({ ...ROLE_PROMPTS, judge })

  it("materializes edited text into its own version and never touches roles-1", () => {
    const before = { ...ROLE_PROMPTS }
    const profile = materializeCustomRoleProfile(edited("# Judge\nOutput a JudgeReport."))
    expect(profile.version).toMatch(/^roles-1-custom@[0-9a-f]{16}$/)
    expect(isMaterializedCustomRoleVersion(profile.version)).toBe(true)
    expect(isMaterializedCustomRoleVersion(CUSTOM_ROLE_PROMPT_VERSION)).toBe(false)
    expect(isMaterializedCustomRoleVersion(ROLE_PROMPT_VERSION)).toBe(false)
    expect(profile.version).toBe(customRolePromptVersion(profile.prompts))
    expect(systemPromptFor("judge", profile)).toBe(
      `${ROLE_PROMPTS.common}\n# Judge\nOutput a JudgeReport.`
    )
    // The shipped text is unchanged and still what a call without a profile sends.
    expect(ROLE_PROMPTS).toEqual(before)
    expect(systemPromptFor("judge")).toBe(`${ROLE_PROMPTS.common}\n${ROLE_PROMPTS.judge}`)
    expect(Object.isFrozen(profile.prompts)).toBe(true)
  })

  it("gives different text a different version and the same text the same one", () => {
    const a = materializeCustomRoleProfile(edited("judge A JudgeReport"))
    const b = materializeCustomRoleProfile(edited("judge B JudgeReport"))
    expect(a.version).not.toBe(b.version)
    expect(materializeCustomRoleProfile(edited("judge A JudgeReport")).version).toBe(a.version)
  })

  it("refuses a profile that leaves a role out", () => {
    const { compactor: _dropped, ...partial } = ROLE_PROMPTS
    expect(() => materializeCustomRoleProfile(partial as Record<RolePromptName, string>)).toThrow(
      /compactor/
    )
  })
})
