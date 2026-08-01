{{- define "cognia-diagnostics.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "cognia-diagnostics.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name (include "cognia-diagnostics.name" .) | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{- define "cognia-diagnostics.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
app.kubernetes.io/name: {{ include "cognia-diagnostics.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "cognia-diagnostics.selectorLabels" -}}
app.kubernetes.io/name: {{ include "cognia-diagnostics.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "cognia-diagnostics.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "cognia-diagnostics.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{- define "cognia-diagnostics.image" -}}
{{- printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag) }}
{{- end }}

{{- define "cognia-diagnostics.secretEnv" -}}
- name: DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ .Values.existingSecret.name }}
      key: {{ .Values.existingSecret.keys.databaseUrl }}
- name: GRANT_SIGNING_KEY
  valueFrom:
    secretKeyRef:
      name: {{ .Values.existingSecret.name }}
      key: {{ .Values.existingSecret.keys.grantSigningKey }}
- name: S3_ACCESS_KEY
  valueFrom:
    secretKeyRef:
      name: {{ .Values.existingSecret.name }}
      key: {{ .Values.existingSecret.keys.s3AccessKey }}
- name: S3_SECRET_KEY
  valueFrom:
    secretKeyRef:
      name: {{ .Values.existingSecret.name }}
      key: {{ .Values.existingSecret.keys.s3SecretKey }}
- name: KMS_ACCESS_KEY_ID
  valueFrom:
    secretKeyRef:
      name: {{ .Values.existingSecret.name }}
      key: {{ .Values.existingSecret.keys.kmsAccessKeyId }}
- name: KMS_SECRET_ACCESS_KEY
  valueFrom:
    secretKeyRef:
      name: {{ .Values.existingSecret.name }}
      key: {{ .Values.existingSecret.keys.kmsSecretAccessKey }}
- name: KMS_SESSION_TOKEN
  valueFrom:
    secretKeyRef:
      name: {{ .Values.existingSecret.name }}
      key: {{ .Values.existingSecret.keys.kmsSessionToken }}
      optional: true
- name: ALERT_WEBHOOK_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ .Values.existingSecret.name }}
      key: {{ .Values.existingSecret.keys.alertWebhookSecret }}
      optional: true
- name: ALERT_SMTP_URL
  valueFrom:
    secretKeyRef:
      name: {{ .Values.existingSecret.name }}
      key: {{ .Values.existingSecret.keys.alertSmtpUrl }}
      optional: true
{{- end }}

{{- define "cognia-diagnostics.configEnv" -}}
- name: DIAGNOSTIC_BIND
  value: "0.0.0.0:8080"
- name: DATABASE_MAX_CONNECTIONS
  value: {{ .Values.config.databaseMaxConnections | quote }}
{{- if .Values.config.s3Endpoint }}
- name: S3_ENDPOINT
  value: {{ .Values.config.s3Endpoint | quote }}
{{- end }}
{{- if .Values.config.objectStoreLocalDir }}
- name: OBJECT_STORE_LOCAL_DIR
  value: {{ .Values.config.objectStoreLocalDir | quote }}
{{- end }}
- name: DIAGNOSTIC_INGEST_ENABLED
  value: {{ .Values.config.ingestEnabled | quote }}
- name: S3_BUCKET
  value: {{ .Values.config.s3Bucket | quote }}
- name: S3_REGION
  value: {{ .Values.config.s3Region | quote }}
- name: OIDC_ISSUER
  value: {{ .Values.config.oidcIssuer | quote }}
- name: OIDC_AUDIENCE
  value: {{ .Values.config.oidcAudience | quote }}
- name: OIDC_PUBLIC_KEY_PEM
  value: {{ .Values.config.oidcPublicKeyPem | quote }}
- name: KMS_ENDPOINT
  value: {{ .Values.config.kmsEndpoint | quote }}
- name: KMS_REGION
  value: {{ .Values.config.kmsRegion | quote }}
- name: KMS_KEY_ID
  value: {{ .Values.config.kmsKeyId | quote }}
- name: PROCESSING_ENABLED
  value: {{ .Values.config.processingEnabled | quote }}
- name: PROCESSING_BATCH_SIZE
  value: {{ .Values.config.processingBatchSize | quote }}
- name: PROCESSING_INTERVAL_MS
  value: {{ .Values.config.processingIntervalMs | quote }}
- name: MINIDUMP_STACKWALK_TIMEOUT_SECONDS
  value: {{ .Values.config.minidumpStackwalkTimeoutSeconds | quote }}
- name: RETENTION_ENABLED
  value: {{ .Values.config.retentionEnabled | quote }}
- name: RETENTION_INTERVAL_MS
  value: {{ .Values.config.retentionIntervalMs | quote }}
- name: RETENTION_BATCH_SIZE
  value: {{ .Values.config.retentionBatchSize | quote }}
- name: ALERT_ENABLED
  value: {{ .Values.config.alertEnabled | quote }}
- name: ALERT_INTERVAL_MS
  value: {{ .Values.config.alertIntervalMs | quote }}
- name: ALERT_BATCH_SIZE
  value: {{ .Values.config.alertBatchSize | quote }}
- name: ALERT_TIMEOUT_SECONDS
  value: {{ .Values.config.alertTimeoutSeconds | quote }}
{{- if .Values.config.alertWebhookUrl }}
- name: ALERT_WEBHOOK_URL
  value: {{ .Values.config.alertWebhookUrl | quote }}
{{- end }}
- name: ALERT_SMTP_FROM
  value: {{ .Values.config.alertSmtpFrom | quote }}
- name: ALERT_SMTP_TO
  value: {{ .Values.config.alertSmtpTo | quote }}
- name: PROCESSING_TEMP_DIR
  value: /var/lib/cognia/diagnostics/tmp
- name: RUST_LOG
  value: cognia_diagnostic_server=info,tower_http=info
{{- end }}
