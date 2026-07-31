"use client"

import { useTranslations } from "next-intl"

import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  validateBedrockConnectionSettings,
  type BedrockAuthMode,
  type BedrockConnectionSettings,
} from "@cognia/provider-types"

interface BedrockSettingsFieldsProps {
  value: BedrockConnectionSettings
  onChange: (value: BedrockConnectionSettings) => void
}

export function BedrockSettingsFields({ value, onChange }: BedrockSettingsFieldsProps) {
  const t = useTranslations("providers")
  const validation = validateBedrockConnectionSettings(value)
  const issueFields = new Set(validation.issues.map((issue) => issue.field))

  const update = (patch: Partial<BedrockConnectionSettings>) => onChange({ ...value, ...patch })
  const changeMode = (authMode: BedrockAuthMode) => {
    // Preserve every field across auth-mode switches so credential values are
    // not silently deleted from persistent storage when the user previews a
    // different mode.
    onChange({ ...value, authMode })
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="bedrock-auth-mode">{t("configTab.bedrockAuthMode")}</Label>
        <Select
          value={value.authMode}
          onValueChange={(mode) => changeMode(mode as BedrockAuthMode)}
        >
          <SelectTrigger id="bedrock-auth-mode">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="api-key">{t("configTab.bedrockAuthApiKey")}</SelectItem>
            <SelectItem value="iam">{t("configTab.bedrockAuthIam")}</SelectItem>
            <SelectItem value="default-chain">{t("configTab.bedrockAuthDefaultChain")}</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{t("configTab.bedrockAuthHint")}</p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="bedrock-region">{t("configTab.bedrockRegion")}</Label>
        <Input
          id="bedrock-region"
          value={value.region ?? ""}
          onChange={(event) => update({ region: event.target.value })}
          placeholder={t("configTab.bedrockRegionPlaceholder")}
          aria-invalid={issueFields.has("region")}
        />
        {issueFields.has("region") && (
          <p className="text-xs text-destructive">{t("configTab.bedrockRegionRequired")}</p>
        )}
      </div>

      {value.authMode === "api-key" && (
        <div className="space-y-2">
          <Label htmlFor="bedrock-api-key">{t("configTab.bedrockApiKey")}</Label>
          <Input
            id="bedrock-api-key"
            type="password"
            autoComplete="new-password"
            value={value.apiKey ?? ""}
            onChange={(event) => update({ apiKey: event.target.value })}
            aria-invalid={issueFields.has("apiKey")}
          />
          {issueFields.has("apiKey") && (
            <p className="text-xs text-destructive">{t("configTab.bedrockApiKeyRequired")}</p>
          )}
        </div>
      )}

      {value.authMode === "iam" && (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="bedrock-access-key-id">{t("configTab.bedrockAccessKeyId")}</Label>
            <Input
              id="bedrock-access-key-id"
              value={value.accessKeyId ?? ""}
              onChange={(event) => update({ accessKeyId: event.target.value })}
              aria-invalid={issueFields.has("accessKeyId")}
              autoComplete="off"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="bedrock-secret-access-key">
              {t("configTab.bedrockSecretAccessKey")}
            </Label>
            <Input
              id="bedrock-secret-access-key"
              type="password"
              value={value.secretAccessKey ?? ""}
              onChange={(event) => update({ secretAccessKey: event.target.value })}
              aria-invalid={issueFields.has("secretAccessKey")}
              autoComplete="new-password"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="bedrock-session-token">{t("configTab.bedrockSessionToken")}</Label>
            <Input
              id="bedrock-session-token"
              type="password"
              value={value.sessionToken ?? ""}
              onChange={(event) => update({ sessionToken: event.target.value })}
              autoComplete="new-password"
            />
          </div>
        </div>
      )}

      {value.authMode === "default-chain" && (
        <div className="space-y-4">
          <p className="text-xs text-muted-foreground">{t("configTab.bedrockDefaultChainHint")}</p>
          <div className="space-y-2">
            <Label htmlFor="bedrock-profile">{t("configTab.bedrockProfile")}</Label>
            <Input
              id="bedrock-profile"
              value={value.profile ?? ""}
              onChange={(event) => update({ profile: event.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="bedrock-role-arn">{t("configTab.bedrockRoleArn")}</Label>
            <Input
              id="bedrock-role-arn"
              value={value.roleArn ?? ""}
              onChange={(event) => update({ roleArn: event.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="bedrock-role-session-name">
              {t("configTab.bedrockRoleSessionName")}
            </Label>
            <Input
              id="bedrock-role-session-name"
              value={value.roleSessionName ?? ""}
              onChange={(event) => update({ roleSessionName: event.target.value })}
            />
          </div>
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="bedrock-base-url">{t("configTab.bedrockBaseURL")}</Label>
        <Input
          id="bedrock-base-url"
          value={value.baseURL ?? ""}
          onChange={(event) => update({ baseURL: event.target.value })}
          placeholder={t("configTab.bedrockBaseURLPlaceholder")}
        />
      </div>
    </div>
  )
}
