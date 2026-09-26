/** Bedrock connection settings as the renderer resolved them. */
export interface BedrockSettings {
  authMode?: unknown
  region?: unknown
  apiKey?: unknown
  accessKeyId?: unknown
  secretAccessKey?: unknown
  sessionToken?: string
  profile?: string
  roleArn?: string
  roleSessionName?: string
  baseURL?: string
}

/** An AWS credential provider, as `@aws-sdk/credential-providers` builds them. */
export type AwsCredentialProvider = () => PromiseLike<{
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
}>

/** The `@aws-sdk/credential-providers` factories this module calls. */
export interface CredentialProviderFactories {
  fromNodeProviderChain(init: {
    profile?: string
    clientConfig: { region: string }
  }): AwsCredentialProvider
  fromTemporaryCredentials(init: {
    masterCredentials: AwsCredentialProvider
    clientConfig: { region: string }
    params: { RoleArn: string; RoleSessionName: string }
  }): AwsCredentialProvider
}

/** The `@aws-sdk/client-bedrock` surface model discovery uses. */
export interface BedrockSdk {
  BedrockClient: new (config: { region: string; credentials: unknown; endpoint?: string }) => {
    send(command: unknown): Promise<unknown>
  }
  ListFoundationModelsCommand: new (input: Record<string, never>) => unknown
  ListInferenceProfilesCommand: new (input: { typeEquals: string }) => unknown
}

/** Options for `createAmazonBedrock`; never carries diagnostic data. */
export interface BedrockProviderOptions {
  region: string
  apiKey?: string
  accessKeyId?: string
  secretAccessKey?: string
  sessionToken?: string
  credentialProvider?: AwsCredentialProvider
  baseURL?: string
}

/** One discovered model or inference profile. */
export interface BedrockModel {
  id: string
  name?: string
  provider: string
  supportsVision?: true
  supportsStreaming?: boolean
}

interface FoundationModelSummary {
  modelId?: string
  modelName?: string
  inputModalities?: string[]
  responseStreamingSupported?: unknown
}

interface InferenceProfileSummary {
  inferenceProfileId?: string
  inferenceProfileArn?: string
  inferenceProfileName?: string
}

function required(
  settings: BedrockSettings | null | undefined,
  field: keyof BedrockSettings,
  label: string
): string {
  const value = settings?.[field]
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Amazon Bedrock ${label} is required`)
  }
  return value.trim()
}

export async function createBedrockCredentialProvider(
  settings: BedrockSettings | null | undefined,
  injected?: CredentialProviderFactories
): Promise<AwsCredentialProvider> {
  if (settings?.authMode !== "default-chain") {
    throw new Error("Amazon Bedrock default credential chain was not selected")
  }
  const region = required(settings, "region", "region")
  const providers: CredentialProviderFactories =
    injected ??
    // The SDK's own signatures are wider than the slice this module calls.
    ((await import("@aws-sdk/credential-providers")) as unknown as CredentialProviderFactories)
  const base = providers.fromNodeProviderChain({
    ...(settings!.profile?.trim() ? { profile: settings!.profile.trim() } : {}),
    clientConfig: { region },
  })
  if (!settings!.roleArn?.trim()) return base
  return providers.fromTemporaryCredentials({
    masterCredentials: base,
    clientConfig: { region },
    params: {
      RoleArn: settings!.roleArn.trim(),
      RoleSessionName: settings!.roleSessionName?.trim() || "cognia-bedrock",
    },
  })
}

/** Build @ai-sdk/amazon-bedrock options without ever returning diagnostic data. */
export async function buildBedrockProviderOptions(
  settings: BedrockSettings | null | undefined,
  injectedCredentialProviders?: CredentialProviderFactories
): Promise<BedrockProviderOptions> {
  const authMode = settings?.authMode ?? "api-key"
  const region = required(settings, "region", "region")
  // `required` threw above unless settings is an object.
  const s = settings!
  const baseURL = s.baseURL?.trim()

  if (authMode === "api-key") {
    return {
      apiKey: required(settings, "apiKey", "API key"),
      region,
      ...(baseURL ? { baseURL } : {}),
    }
  }
  if (authMode === "iam") {
    return {
      region,
      accessKeyId: required(settings, "accessKeyId", "access key ID"),
      secretAccessKey: required(settings, "secretAccessKey", "secret access key"),
      ...(s.sessionToken?.trim() ? { sessionToken: s.sessionToken.trim() } : {}),
      ...(baseURL ? { baseURL } : {}),
    }
  }
  if (authMode === "default-chain") {
    return {
      region,
      credentialProvider: await createBedrockCredentialProvider(
        settings,
        injectedCredentialProviders
      ),
      ...(baseURL ? { baseURL } : {}),
    }
  }
  throw new Error(`Unsupported Amazon Bedrock auth mode: ${authMode}`)
}

function providerFromModelId(id: string): string {
  const parts = id.split(".")
  if (["us", "eu", "apac", "jp"].includes(parts[0]!) && parts.length > 1) return parts[1]!
  return parts[0]!
}

function normalizeFoundationModel(
  model: FoundationModelSummary | null | undefined
): BedrockModel | undefined {
  if (!model?.modelId) return undefined
  return {
    id: model.modelId,
    ...(model.modelName ? { name: model.modelName } : {}),
    provider: providerFromModelId(model.modelId),
    ...(model.inputModalities?.includes("IMAGE") ? { supportsVision: true } : {}),
    ...(typeof model.responseStreamingSupported === "boolean"
      ? { supportsStreaming: model.responseStreamingSupported }
      : {}),
  }
}

function normalizeInferenceProfile(
  profile: InferenceProfileSummary | null | undefined
): BedrockModel | undefined {
  const id = profile?.inferenceProfileId ?? profile?.inferenceProfileArn
  if (!id) return undefined
  return {
    id,
    ...(profile!.inferenceProfileName ? { name: profile!.inferenceProfileName } : {}),
    provider: providerFromModelId(id),
  }
}

export async function discoverBedrockModels(
  settings: BedrockSettings | null | undefined,
  injectedAws?: BedrockSdk
): Promise<BedrockModel[]> {
  if (settings?.authMode === "api-key") {
    throw new Error(
      "Amazon Bedrock model discovery requires IAM or the AWS default credential chain"
    )
  }
  const region = required(settings, "region", "region")
  const s = settings!
  const aws: BedrockSdk =
    injectedAws ??
    // The SDK's own signatures are wider than the slice this module calls.
    ((await import("@aws-sdk/client-bedrock")) as unknown as BedrockSdk)
  let credentials: unknown
  if (s.authMode === "iam") {
    credentials = {
      accessKeyId: required(settings, "accessKeyId", "access key ID"),
      secretAccessKey: required(settings, "secretAccessKey", "secret access key"),
      ...(s.sessionToken?.trim() ? { sessionToken: s.sessionToken.trim() } : {}),
    }
  } else {
    credentials = await createBedrockCredentialProvider(settings)
  }
  const client = new aws.BedrockClient({
    region,
    credentials,
    ...(s.baseURL?.trim() ? { endpoint: s.baseURL.trim() } : {}),
  })
  const [foundation, profiles] = (await Promise.all([
    client.send(new aws.ListFoundationModelsCommand({})),
    client.send(new aws.ListInferenceProfilesCommand({ typeEquals: "SYSTEM_DEFINED" })),
  ])) as [
    { modelSummaries?: FoundationModelSummary[] },
    { inferenceProfileSummaries?: InferenceProfileSummary[] },
  ]
  const byId = new Map<string, BedrockModel>()
  for (const raw of foundation.modelSummaries ?? []) {
    const model = normalizeFoundationModel(raw)
    if (model) byId.set(model.id, model)
  }
  for (const raw of profiles.inferenceProfileSummaries ?? []) {
    const model = normalizeInferenceProfile(raw)
    if (model) byId.set(model.id, { ...byId.get(model.id), ...model })
  }
  return [...byId.values()]
}
