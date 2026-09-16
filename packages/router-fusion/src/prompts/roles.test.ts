import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { ROLE_PROMPT_FILES, ROLE_PROMPT_VERSION, ROLE_PROMPTS, systemPromptFor } from "./roles"

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
})
