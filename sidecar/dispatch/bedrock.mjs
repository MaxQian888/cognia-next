function required(settings, field, label) {
  const value = settings?.[field]
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Amazon Bedrock ${label} is required`)
  }
  return value.trim()
}

export async function createBedrockCredentialProvider(settings, injected) {
  if (settings?.authMode !== "default-chain") {
    throw new Error("Amazon Bedrock default credential chain was not selected")
  }
  const region = required(settings, "region", "region")
  const providers = injected ?? (await import("@aws-sdk/credential-providers"))
  const base = providers.fromNodeProviderChain({
    ...(settings.profile?.trim() ? { profile: settings.profile.trim() } : {}),
    clientConfig: { region },
  })
  if (!settings.roleArn?.trim()) return base
  return providers.fromTemporaryCredentials({
    masterCredentials: base,
    clientConfig: { region },
    params: {
      RoleArn: settings.roleArn.trim(),
      RoleSessionName: settings.roleSessionName?.trim() || "cognia-bedrock",
    },
  })
}

/** Build @ai-sdk/amazon-bedrock options without ever returning diagnostic data. */
export async function buildBedrockProviderOptions(settings, injectedCredentialProviders) {
  const authMode = settings?.authMode ?? "api-key"
  const region = required(settings, "region", "region")
  const baseURL = settings.baseURL?.trim()

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
      ...(settings.sessionToken?.trim() ? { sessionToken: settings.sessionToken.trim() } : {}),
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

function providerFromModelId(id) {
  const parts = id.split(".")
  if (["us", "eu", "apac", "jp"].includes(parts[0]) && parts.length > 1) return parts[1]
  return parts[0]
}

function normalizeFoundationModel(model) {
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

function normalizeInferenceProfile(profile) {
  const id = profile?.inferenceProfileId ?? profile?.inferenceProfileArn
  if (!id) return undefined
  return {
    id,
    ...(profile.inferenceProfileName ? { name: profile.inferenceProfileName } : {}),
    provider: providerFromModelId(id),
  }
}

export async function discoverBedrockModels(settings, injectedAws) {
  if (settings?.authMode === "api-key") {
    throw new Error(
      "Amazon Bedrock model discovery requires IAM or the AWS default credential chain"
    )
  }
  const region = required(settings, "region", "region")
  const aws = injectedAws ?? (await import("@aws-sdk/client-bedrock"))
  let credentials
  if (settings.authMode === "iam") {
    credentials = {
      accessKeyId: required(settings, "accessKeyId", "access key ID"),
      secretAccessKey: required(settings, "secretAccessKey", "secret access key"),
      ...(settings.sessionToken?.trim() ? { sessionToken: settings.sessionToken.trim() } : {}),
    }
  } else {
    credentials = await createBedrockCredentialProvider(settings)
  }
  const client = new aws.BedrockClient({
    region,
    credentials,
    ...(settings.baseURL?.trim() ? { endpoint: settings.baseURL.trim() } : {}),
  })
  const [foundation, profiles] = await Promise.all([
    client.send(new aws.ListFoundationModelsCommand({})),
    client.send(new aws.ListInferenceProfilesCommand({ typeEquals: "SYSTEM_DEFINED" })),
  ])
  const byId = new Map()
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
