/**
 * `owner/repo` as an installation names it. The host scopes every Bot read to
 * the bound repository, so this is input hygiene rather than the security
 * boundary, but a `..` segment is still refused here: it would turn the
 * `/repos/{owner}/{repo}` prefix into a different API path before the host
 * ever saw it.
 */
export const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

export function isRepositoryName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    REPOSITORY_PATTERN.test(value) &&
    value.split("/").every((segment) => segment !== "." && segment !== "..")
  )
}

/**
 * Parse an installation's repository setting. Unset is a setup error with the
 * caller's own wording; a malformed value is a plain validation error.
 */
export function parseRepository(value: unknown, requiredMessage: string): string {
  if (value === undefined || value === null || value === "") throw new Error(requiredMessage)
  if (!isRepositoryName(value)) throw new Error("repository must be owner/repo")
  return value
}

/** The Bot resource id of an issue or pull request: case-insensitive, like GitHub. */
export const resourceId = (repository: string, number: number) =>
  `${repository.toLowerCase()}#${number}`
