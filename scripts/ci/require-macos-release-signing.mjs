import { pathToFileURL } from "node:url"

const REQUIRED_VARIABLES = [
  "APPLE_CERTIFICATE",
  "APPLE_CERTIFICATE_PASSWORD",
  "APPLE_SIGNING_IDENTITY",
  "APPLE_ID",
  "APPLE_PASSWORD",
  "APPLE_TEAM_ID",
]

export function validateMacosReleaseSigning(environment) {
  const missing = REQUIRED_VARIABLES.filter((name) => !environment[name]?.trim())
  if (missing.length > 0) {
    throw new Error(`Missing required macOS release secrets: ${missing.join(", ")}`)
  }

  const identity = environment.APPLE_SIGNING_IDENTITY.trim()
  if (!identity.startsWith("Developer ID Application: ")) {
    throw new Error(
      "APPLE_SIGNING_IDENTITY must be a Developer ID Application identity; ad-hoc and development identities are forbidden"
    )
  }

  const teamId = environment.APPLE_TEAM_ID.trim()
  if (!/^[A-Z0-9]{10}$/.test(teamId)) {
    throw new Error("APPLE_TEAM_ID must be a 10-character uppercase Apple Team ID")
  }

  const identityTeamId = identity.match(/\(([A-Z0-9]{10})\)$/)?.[1]
  if (!identityTeamId || identityTeamId !== teamId) {
    throw new Error("APPLE_TEAM_ID does not match the Team ID in APPLE_SIGNING_IDENTITY")
  }

  return { identity, teamId }
}

function main() {
  validateMacosReleaseSigning(process.env)
  process.stdout.write("macOS release signing preflight passed.\n")
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } catch (error) {
    process.stderr.write(
      `macOS release signing preflight failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`
    )
    process.exitCode = 1
  }
}
