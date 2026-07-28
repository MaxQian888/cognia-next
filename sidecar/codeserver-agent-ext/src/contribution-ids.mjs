/**
 * Enumerate the Code 1.128 contribution identifiers that occupy a global
 * extension-host registry. The same table is used at generation time and at
 * activation time so a proxy cannot pass one gate and collide at the other.
 */
export function collectContributionIds(contributions = {}) {
  const ids = []
  const add = (kind, id) => {
    if (typeof id === "string" && id.length > 0) ids.push({ kind, id })
  }
  for (const entry of contributions.commands ?? []) add("command", entry.command)
  for (const entry of contributions.submenus ?? []) add("submenu", entry.id)
  for (const entry of contributions.languages ?? []) add("language", entry.id)
  for (const entry of contributions.themes ?? []) add("theme", entry.id)
  for (const entry of contributions.iconThemes ?? []) add("iconTheme", entry.id)
  for (const entry of contributions.productIconThemes ?? []) add("productIconTheme", entry.id)
  for (const entry of contributions.colors ?? []) add("color", entry.id)
  for (const id of Object.keys(contributions.icons ?? {})) add("icon", id)
  for (const entries of Object.values(contributions.viewsContainers ?? {})) {
    for (const entry of entries) add("viewContainer", entry.id)
  }
  for (const entries of Object.values(contributions.views ?? {})) {
    for (const entry of entries) add("view", entry.id)
  }
  for (const entry of contributions.walkthroughs ?? []) {
    add("walkthrough", entry.id)
    for (const step of entry.steps ?? []) add("walkthroughStep", step.id)
  }
  for (const entry of contributions.customEditors ?? []) add("customEditor", entry.viewType)
  for (const entry of contributions.notebooks ?? []) add("notebook", entry.type)
  for (const entry of contributions.notebookRenderer ?? []) add("notebookRenderer", entry.id)
  for (const entry of contributions.debuggers ?? []) add("debugger", entry.type)
  for (const entry of contributions.taskDefinitions ?? []) add("taskDefinition", entry.type)
  for (const entry of contributions.problemMatchers ?? []) add("problemMatcher", entry.name)
  for (const entry of contributions.problemPatterns ?? []) add("problemPattern", entry.name)
  for (const entry of contributions.terminal?.profiles ?? []) add("terminalProfile", entry.id)
  for (const entry of contributions.authentication ?? []) add("authentication", entry.id)
  for (const entry of contributions.languageModelChatProviders ?? []) {
    add("languageModelChatProvider", entry.vendor)
  }
  for (const entry of contributions.mcpServerDefinitionProviders ?? []) {
    add("mcpServerDefinitionProvider", entry.id)
  }
  for (const entry of contributions.languageModelTools ?? []) {
    add("languageModelTool", entry.name)
  }
  for (const entry of contributions.chatParticipants ?? []) {
    add("chatParticipant", entry.id)
  }
  return ids
}

export function assertManagedContributionIds(pluginId, contributions) {
  const prefix = `cognia.${pluginId}.`
  const seen = new Set()
  for (const entry of collectContributionIds(contributions)) {
    if (!entry.id.startsWith(prefix)) {
      throw compatibilityError("IDE_PROXY_ID_OUTSIDE_NAMESPACE", `${entry.kind}:${entry.id}`)
    }
    const key = `${entry.kind}\0${entry.id}`
    if (seen.has(key)) {
      throw compatibilityError("IDE_PROXY_ID_DUPLICATE", `${entry.kind}:${entry.id}`)
    }
    seen.add(key)
  }
}

export function findOccupiedContributionIds(vscode, descriptor, ownExtensionId) {
  const wanted = new Set(
    collectContributionIds(descriptor.contributions).map((entry) => `${entry.kind}\0${entry.id}`)
  )
  const collisions = []
  for (const extension of vscode.extensions?.all ?? []) {
    if (extension.id === ownExtensionId) continue
    for (const entry of collectContributionIds(extension.packageJSON?.contributes)) {
      if (wanted.has(`${entry.kind}\0${entry.id}`)) {
        collisions.push({
          kind: entry.kind,
          id: entry.id,
          extensionId: extension.id,
        })
      }
    }
  }
  return collisions.sort((left, right) =>
    `${left.kind}:${left.id}:${left.extensionId}`.localeCompare(
      `${right.kind}:${right.id}:${right.extensionId}`
    )
  )
}

function compatibilityError(code, detail) {
  const error = new Error(`${code}: ${detail}`)
  error.code = code
  return error
}
