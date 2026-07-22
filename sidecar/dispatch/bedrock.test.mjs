import test from "node:test"
import assert from "node:assert/strict"

import {
  buildBedrockProviderOptions,
  createBedrockCredentialProvider,
  discoverBedrockModels,
} from "./bedrock.mjs"

test("buildBedrockProviderOptions preserves API-key precedence", async () => {
  const options = await buildBedrockProviderOptions({
    authMode: "api-key",
    region: "us-east-1",
    apiKey: "bedrock-secret",
    accessKeyId: "must-not-be-used",
    secretAccessKey: "must-not-be-used",
  })
  assert.deepEqual(options, { apiKey: "bedrock-secret", region: "us-east-1" })
})

test("buildBedrockProviderOptions builds explicit IAM settings", async () => {
  const options = await buildBedrockProviderOptions({
    authMode: "iam",
    region: "eu-west-1",
    accessKeyId: "AKIAEXAMPLE",
    secretAccessKey: "secret",
    sessionToken: "session",
  })
  assert.deepEqual(options, {
    region: "eu-west-1",
    accessKeyId: "AKIAEXAMPLE",
    secretAccessKey: "secret",
    sessionToken: "session",
  })
})

test("default-chain composes profile resolution and optional role assumption", async () => {
  const calls = []
  const base = async () => ({ accessKeyId: "base", secretAccessKey: "base-secret" })
  const assumed = async () => ({ accessKeyId: "role", secretAccessKey: "role-secret" })
  const provider = await createBedrockCredentialProvider(
    {
      authMode: "default-chain",
      region: "ap-southeast-1",
      profile: "engineering",
      roleArn: "arn:aws:iam::123456789012:role/Cognia",
      roleSessionName: "cognia-test",
    },
    {
      fromNodeProviderChain(options) {
        calls.push(["chain", options])
        return base
      },
      fromTemporaryCredentials(options) {
        calls.push(["role", options])
        return assumed
      },
    }
  )

  assert.equal(provider, assumed)
  assert.equal(calls[0][0], "chain")
  assert.equal(calls[0][1].profile, "engineering")
  assert.equal(calls[1][1].masterCredentials, base)
  assert.deepEqual(calls[1][1].params, {
    RoleArn: "arn:aws:iam::123456789012:role/Cognia",
    RoleSessionName: "cognia-test",
  })
})

test("discovery merges foundation models and inference profiles without credentials in output", async () => {
  class MockClient {
    async send(command) {
      if (command.kind === "foundation") {
        return {
          modelSummaries: [
            {
              modelId: "amazon.nova-lite-v1:0",
              modelName: "Nova Lite",
              inputModalities: ["TEXT", "IMAGE"],
              outputModalities: ["TEXT"],
              responseStreamingSupported: true,
            },
          ],
        }
      }
      return {
        inferenceProfileSummaries: [
          {
            inferenceProfileId: "us.amazon.nova-lite-v1:0",
            inferenceProfileName: "US Nova Lite",
          },
        ],
      }
    }
  }
  class FoundationCommand {
    kind = "foundation"
  }
  class ProfileCommand {
    kind = "profile"
  }

  const result = await discoverBedrockModels(
    {
      authMode: "iam",
      region: "us-east-1",
      accessKeyId: "AKIA-DO-NOT-RETURN",
      secretAccessKey: "secret-do-not-return",
    },
    {
      BedrockClient: MockClient,
      ListFoundationModelsCommand: FoundationCommand,
      ListInferenceProfilesCommand: ProfileCommand,
    }
  )

  assert.deepEqual(result, [
    {
      id: "amazon.nova-lite-v1:0",
      name: "Nova Lite",
      provider: "amazon",
      supportsVision: true,
      supportsStreaming: true,
    },
    {
      id: "us.amazon.nova-lite-v1:0",
      name: "US Nova Lite",
      provider: "amazon",
    },
  ])
  assert.equal(JSON.stringify(result).includes("DO-NOT-RETURN"), false)
  assert.equal(JSON.stringify(result).includes("secret-do-not-return"), false)
})
