// Idempotent first-run seeder for built-in characters, skills, and teams.
//
// Called once per process from `getDb()` (lazy import to avoid the cycle
// schema → seed → characters/skills/teams → schema). Each seeder uses stable
// ids and `bulkPut`, so reseeding is safe and never duplicates rows.

import { seedBuiltInCharacters } from "./characters"
import { seedBuiltInSkills } from "./skills"
import { seedBuiltInTeams } from "./teams"
import { seedBuiltInPresets } from "./prompt-presets"
import { seedBuiltInWorkflowTemplates } from "@/lib/workflow/definition/seed"

/**
 * Run all built-in seeders. Skills, characters, presets, and workflow
 * templates seed in parallel — none of them reference each other. Teams seed
 * after because the built-in team references built-in character ids.
 */
export async function seedBuiltIns(): Promise<void> {
  await Promise.all([
    seedBuiltInCharacters(),
    seedBuiltInSkills(),
    seedBuiltInPresets(),
    seedBuiltInWorkflowTemplates(),
  ])
  await seedBuiltInTeams()
}
