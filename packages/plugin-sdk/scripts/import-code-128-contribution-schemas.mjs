import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const outputPath = resolve(root, "contract/code-1.128-contribution-schemas.json")

const expectedSources = [
  {
    id: "vscodeExtensions",
    uri: "vscode://schemas/vscode-extensions",
    argument: "--extension-schema",
    sha256: "850c7354c7c85ebc7060b44b372912048a69772d90c0abccf60926ec0f7f1975",
  },
  {
    id: "toolsParameters",
    uri: "vscode://schemas/toolsParameters",
    argument: "--tools-parameters-schema",
    sha256: "13c8719ad8e0808026865484816660a5a3373cc1d757eb55cac8f537016fd8cc",
  },
  {
    id: "configurationDefaults",
    uri: "vscode://schemas/settings/configurationDefaults",
    argument: "--configuration-defaults-schema",
    sha256: "ff2ab6d35658a1d245ec3f7cdcd49cf22436d4bdb341a6e17b88870ce2f7e36f",
  },
  {
    id: "resourceLanguage",
    uri: "vscode://schemas/settings/resourceLanguage",
    argument: "--resource-language-schema",
    sha256: "9859849c87d7f0e803fd17a1df2e8ee81e1db37724208e6d525ba092d60633cc",
  },
  {
    id: "workbenchColors",
    uri: "vscode://schemas/workbench-colors",
    argument: "--workbench-colors-schema",
    sha256: "7940b68853063d8ae557d293eaf24872f945078802315c01085772d8cab39bb4",
  },
  {
    id: "textmateColors",
    uri: "vscode://schemas/textmate-colors",
    argument: "--textmate-colors-schema",
    sha256: "0652d3b0cfb960a98f9a6e4c25b9b3e51d55c8fab369aea8ca04086e7d6d32e3",
  },
  {
    id: "tokenStyling",
    uri: "vscode://schemas/token-styling",
    argument: "--token-styling-schema",
    sha256: "7e8afe8a1b4662ad40c77ffdd615671a273c055dc9356ac7539b9b13082683de",
  },
  {
    id: "typescriptServerPlugins",
    uri: "extensions/typescript-language-features/schemas/package.schema.json",
    argument: "--typescript-plugin-schema",
    sha256: "fd005a6177fdbdcaa919fd7b97257cb0935d73c098dc9ba77d49a4203bfd423c",
  },
  {
    id: "draft07",
    uri: "http://json-schema.org/draft-07/schema#",
    argument: "--draft-07-schema",
    sha256: "f7e8b13cad4fecff9771f3626fef33e20e59027b90938a28fd9d2f6c17cd0773",
  },
]

const argumentsByName = parseArguments(process.argv.slice(2))
const sources = {}
const sourceMetadata = {}

for (const expected of expectedSources) {
  const path = argumentsByName.get(expected.argument)
  if (!path) {
    throw new Error(`Missing required ${expected.argument} <path>`)
  }
  const bytes = await readFile(resolve(path))
  const actualSha256 = createHash("sha256").update(bytes).digest("hex")
  if (actualSha256 !== expected.sha256) {
    throw new Error(
      `${expected.id} schema digest mismatch: expected ${expected.sha256}, received ${actualSha256}`
    )
  }
  sources[expected.id] = JSON.parse(bytes.toString("utf8"))
  sourceMetadata[expected.id] = {
    uri: expected.uri,
    sha256: expected.sha256,
  }
}

const globalContributions = sources.vscodeExtensions?.properties?.contributes?.properties
if (!globalContributions || typeof globalContributions !== "object") {
  throw new Error("vscode://schemas/vscode-extensions has no contribution property registry")
}
const typescriptServerPlugins =
  sources.typescriptServerPlugins?.properties?.contributes?.properties?.typescriptServerPlugins
if (!typescriptServerPlugins || typeof typescriptServerPlugins !== "object") {
  throw new Error("TypeScript built-in package schema has no typescriptServerPlugins contribution")
}

const artifact = {
  schemaVersion: 1,
  source: {
    codeServerVersion: "4.128.0",
    codeServerArchiveSha256: "72326a25a8171b508e02b9c956daf29459801fe01ddd0b67ef2bf2ad4a212092",
    codeVersion: "1.128.0",
    codeCommit: "fc3def6774c76082adf699d366f31a557ce5573f",
    extraction: "live-code-server-schema-registry",
    schemas: sourceMetadata,
  },
  contributions: {
    ...globalContributions,
    typescriptServerPlugins,
  },
  definitions: sources.vscodeExtensions.$defs ?? {},
  referencedSchemas: {
    "vscode://schemas/toolsParameters": sources.toolsParameters,
    "vscode://schemas/settings/configurationDefaults": sources.configurationDefaults,
    "vscode://schemas/settings/resourceLanguage": sources.resourceLanguage,
    "vscode://schemas/workbench-colors": sources.workbenchColors,
    "vscode://schemas/textmate-colors": sources.textmateColors,
    "vscode://schemas/token-styling": sources.tokenStyling,
    "http://json-schema.org/draft-07/schema#": sources.draft07,
  },
}

await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`)
console.log(`imported ${outputPath}`)

function parseArguments(args) {
  const result = new Map()
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]
    const value = args[index + 1]
    if (!name?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(`Expected --name <path>, received ${args.slice(index).join(" ")}`)
    }
    result.set(name, value)
  }
  return result
}
