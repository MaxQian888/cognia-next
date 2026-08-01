use std::{collections::BTreeMap, time::Duration};

use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::{DateTime, Utc};
use hmac::{Hmac, Mac};
use reqwest::{header::HeaderMap, Url};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use uuid::Uuid;

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Clone)]
pub struct GeneratedDataKey {
    pub plaintext: [u8; 32],
    pub wrapped: Vec<u8>,
}

#[async_trait]
pub trait KeyWrappingService: Send + Sync {
    async fn generate_data_key(&self, tenant_id: Uuid) -> anyhow::Result<GeneratedDataKey>;
    async fn decrypt_data_key(&self, tenant_id: Uuid, wrapped: &[u8]) -> anyhow::Result<[u8; 32]>;
}

#[derive(Clone)]
pub struct AwsKmsClient {
    client: reqwest::Client,
    endpoint: Url,
    region: String,
    key_id: String,
    access_key: String,
    secret_key: String,
    session_token: Option<String>,
}

impl AwsKmsClient {
    pub fn new(
        endpoint: Url,
        region: String,
        key_id: String,
        access_key: String,
        secret_key: String,
        session_token: Option<String>,
        timeout: Duration,
    ) -> anyhow::Result<Self> {
        if endpoint.query().is_some() || endpoint.host_str().is_none() {
            anyhow::bail!("KMS endpoint must be an absolute URL without a query");
        }
        Ok(Self {
            client: reqwest::Client::builder().timeout(timeout).build()?,
            endpoint,
            region,
            key_id,
            access_key,
            secret_key,
            session_token,
        })
    }

    async fn request<T: for<'de> Deserialize<'de>>(
        &self,
        target: &str,
        body: serde_json::Value,
    ) -> anyhow::Result<T> {
        let body = serde_json::to_vec(&body)?;
        let headers = sign_request(
            &self.endpoint,
            &self.region,
            &self.access_key,
            &self.secret_key,
            self.session_token.as_deref(),
            target,
            &body,
            Utc::now(),
        )?;
        let response = self
            .client
            .post(self.endpoint.clone())
            .headers(headers)
            .body(body)
            .send()
            .await?;
        let status = response.status();
        if !status.is_success() {
            anyhow::bail!("KMS request failed with status {status}");
        }
        Ok(response.json().await?)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct GenerateDataKeyResponse {
    plaintext: String,
    ciphertext_blob: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct DecryptResponse {
    plaintext: String,
}

#[async_trait]
impl KeyWrappingService for AwsKmsClient {
    async fn generate_data_key(&self, tenant_id: Uuid) -> anyhow::Result<GeneratedDataKey> {
        let response: GenerateDataKeyResponse = self
            .request(
                "TrentService.GenerateDataKey",
                serde_json::json!({
                    "KeyId": self.key_id,
                    "KeySpec": "AES_256",
                    "EncryptionContext": encryption_context(tenant_id),
                }),
            )
            .await?;
        Ok(GeneratedDataKey {
            plaintext: decode_dek(&response.plaintext)?,
            wrapped: STANDARD.decode(response.ciphertext_blob)?,
        })
    }

    async fn decrypt_data_key(&self, tenant_id: Uuid, wrapped: &[u8]) -> anyhow::Result<[u8; 32]> {
        let response: DecryptResponse = self
            .request(
                "TrentService.Decrypt",
                serde_json::json!({
                    "KeyId": self.key_id,
                    "CiphertextBlob": STANDARD.encode(wrapped),
                    "EncryptionContext": encryption_context(tenant_id),
                }),
            )
            .await?;
        decode_dek(&response.plaintext)
    }
}

fn encryption_context(tenant_id: Uuid) -> BTreeMap<&'static str, String> {
    BTreeMap::from([
        ("purpose", "cognia-diagnostics".to_owned()),
        ("tenantId", tenant_id.to_string()),
    ])
}

fn decode_dek(value: &str) -> anyhow::Result<[u8; 32]> {
    STANDARD
        .decode(value)?
        .try_into()
        .map_err(|_| anyhow::anyhow!("KMS returned a data key with an invalid length"))
}

#[allow(clippy::too_many_arguments)]
fn sign_request(
    endpoint: &Url,
    region: &str,
    access_key: &str,
    secret_key: &str,
    session_token: Option<&str>,
    target: &str,
    body: &[u8],
    now: DateTime<Utc>,
) -> anyhow::Result<HeaderMap> {
    let host = endpoint
        .host_str()
        .ok_or_else(|| anyhow::anyhow!("KMS endpoint has no host"))?;
    let host = match endpoint.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_owned(),
    };
    let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
    let date = now.format("%Y%m%d").to_string();
    let payload_hash = hex::encode(Sha256::digest(body));
    let mut canonical_headers = BTreeMap::from([
        ("content-type", "application/x-amz-json-1.1".to_owned()),
        ("host", host),
        ("x-amz-content-sha256", payload_hash.clone()),
        ("x-amz-date", amz_date.clone()),
        ("x-amz-target", target.to_owned()),
    ]);
    if let Some(token) = session_token {
        canonical_headers.insert("x-amz-security-token", token.to_owned());
    }
    let signed_headers = canonical_headers
        .keys()
        .copied()
        .collect::<Vec<_>>()
        .join(";");
    let canonical_header_text = canonical_headers
        .iter()
        .map(|(name, value)| format!("{name}:{}\n", value.trim()))
        .collect::<String>();
    let canonical_uri = if endpoint.path().is_empty() {
        "/"
    } else {
        endpoint.path()
    };
    let canonical_request =
        format!("POST\n{canonical_uri}\n\n{canonical_header_text}{signed_headers}\n{payload_hash}");
    let credential_scope = format!("{date}/{region}/kms/aws4_request");
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{amz_date}\n{credential_scope}\n{}",
        hex::encode(Sha256::digest(canonical_request.as_bytes()))
    );
    let date_key = hmac_bytes(format!("AWS4{secret_key}").as_bytes(), date.as_bytes())?;
    let region_key = hmac_bytes(&date_key, region.as_bytes())?;
    let service_key = hmac_bytes(&region_key, b"kms")?;
    let signing_key = hmac_bytes(&service_key, b"aws4_request")?;
    let signature = hex::encode(hmac_bytes(&signing_key, string_to_sign.as_bytes())?);
    let authorization = format!(
        "AWS4-HMAC-SHA256 Credential={access_key}/{credential_scope}, SignedHeaders={signed_headers}, Signature={signature}"
    );

    let mut headers = HeaderMap::new();
    for (name, value) in canonical_headers {
        headers.insert(
            reqwest::header::HeaderName::from_bytes(name.as_bytes())?,
            reqwest::header::HeaderValue::from_str(&value)?,
        );
    }
    headers.insert(
        reqwest::header::AUTHORIZATION,
        reqwest::header::HeaderValue::from_str(&authorization)?,
    );
    Ok(headers)
}

fn hmac_bytes(key: &[u8], value: &[u8]) -> anyhow::Result<Vec<u8>> {
    let mut mac = HmacSha256::new_from_slice(key)?;
    mac.update(value);
    Ok(mac.finalize().into_bytes().to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn signer_binds_target_payload_and_session_token_without_exposing_secret() {
        let endpoint = Url::parse("http://kms:4566/").unwrap();
        let now = Utc.with_ymd_and_hms(2026, 8, 1, 0, 0, 0).unwrap();
        let headers = sign_request(
            &endpoint,
            "us-east-1",
            "test-access",
            "test-secret",
            Some("session-token"),
            "TrentService.Decrypt",
            br#"{"CiphertextBlob":"AA=="}"#,
            now,
        )
        .unwrap();
        let authorization = headers
            .get(reqwest::header::AUTHORIZATION)
            .unwrap()
            .to_str()
            .unwrap();
        assert!(
            authorization.contains("Credential=test-access/20260801/us-east-1/kms/aws4_request")
        );
        assert!(authorization.contains("x-amz-security-token"));
        assert!(!authorization.contains("test-secret"));
        assert_eq!(headers["x-amz-target"], "TrentService.Decrypt");
    }

    #[test]
    fn data_key_decoder_requires_exactly_256_bits() {
        assert_eq!(
            decode_dek(&STANDARD.encode([1_u8; 32])).unwrap(),
            [1_u8; 32]
        );
        assert!(decode_dek(&STANDARD.encode([1_u8; 16])).is_err());
    }
}
