import JSZip from "jszip"
import type { Skill, SkillResource } from "@cognia/agent-config-types"
import { serializeSkill } from "@/lib/claude/skills-io"
import { validateSkill } from "@/lib/skills/validate"
import { deriveSkillSlug } from "@/lib/skills/slug"
import { validateResourcePath } from "./limits"

export interface SkillBundleSource {
  skill: Skill
  resources: SkillResource[]
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function portableProjection(source: SkillBundleSource): Skill {
  const slug = deriveSkillSlug(source.skill)
  const inlinePaths = source.resources
    .filter((resource) => resource.inline)
    .map((resource) => resource.path)
  return {
    ...source.skill,
    slug,
    metadata: {
      ...(source.skill.metadata ?? {}),
      ...(inlinePaths.length > 0 ? { "cognia.inline-resources": JSON.stringify(inlinePaths) } : {}),
    },
  }
}

function assertPortable(source: SkillBundleSource): Skill {
  const skill = portableProjection(source)
  const extensionMetadata = skill.frontmatterExtensions?.metadata
  if (
    extensionMetadata &&
    (typeof extensionMetadata !== "object" ||
      Array.isArray(extensionMetadata) ||
      Object.values(extensionMetadata as Record<string, unknown>).some(
        (value) => typeof value !== "string"
      ))
  ) {
    throw new Error("Skill bundle is not portable: metadata values must be strings.")
  }
  const issues = validateSkill({
    name: skill.name,
    slug: skill.slug,
    description: skill.description,
    compatibility: skill.compatibility,
    metadata: skill.metadata,
    content: skill.content,
    resources: source.resources,
  }).filter((issue) => issue.severity !== "warning")
  if (issues.length > 0) {
    throw new Error(
      `Skill bundle is not portable: ${issues.map((issue) => issue.message).join("; ")}`
    )
  }
  return skill
}

function addSkillToZip(zip: JSZip, source: SkillBundleSource, parent = ""): string {
  const skill = assertPortable(source)
  const slug = skill.slug!
  const root = `${parent}${slug}/`
  zip.file(`${root}SKILL.md`, serializeSkill(skill))
  for (const resource of source.resources) {
    const pathError = validateResourcePath(resource.path)
    if (pathError) throw new Error(`Bundle resource rejected: ${pathError}`)
    zip.file(
      `${root}${resource.path}`,
      resource.encoding === "base64" ? decodeBase64(resource.content) : resource.content
    )
  }
  if (skill.codexOpenAiYaml !== undefined) {
    zip.file(`${root}agents/openai.yaml`, skill.codexOpenAiYaml)
  }
  return slug
}

export async function serializeSkillBundle(source: SkillBundleSource): Promise<{
  filename: string
  bytes: Uint8Array
}> {
  const zip = new JSZip()
  const slug = addSkillToZip(zip, source)
  return {
    filename: `${slug}.zip`,
    bytes: await zip.generateAsync({ type: "uint8array" }),
  }
}

export async function serializeSkillBundleBatch(
  sources: SkillBundleSource[],
  date = new Date()
): Promise<{ filename: string; bytes: Uint8Array }> {
  const zip = new JSZip()
  const roots = new Set<string>()
  for (const source of sources) {
    const slug = addSkillToZip(zip, source)
    if (roots.has(slug)) throw new Error(`Duplicate skill slug in export batch: ${slug}`)
    roots.add(slug)
  }
  return {
    filename: `cognia-skills-${date.toISOString().slice(0, 10)}.zip`,
    bytes: await zip.generateAsync({ type: "uint8array" }),
  }
}

/** Compatibility entry point used by the Skills toolbar: always returns one zip payload. */
export async function serializeSkillsBundle(sources: SkillBundleSource[]): Promise<Uint8Array> {
  if (sources.length === 0) throw new Error("Cannot serialize an empty skill bundle.")
  return (await serializeSkillBundleBatch(sources)).bytes
}
