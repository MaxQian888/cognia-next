//! Pinned OpenAI public-client endpoints and verified OIDC identity.
use super::store::Session;
use jsonwebtoken::{decode, decode_header, jwk::JwkSet, Algorithm, DecodingKey, Validation};
use serde::Deserialize;
use serde_json::Value;
use url::Url;

pub const ISSUER: &str = "https://auth.openai.com";
pub const RESOURCE: &str = "https://api.openai.com/v1";
pub const SCOPES: &str =
    "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";

#[derive(Clone)]
pub(super) struct Endpoints {
    pub issuer: String,
    pub authorize: String,
    pub token: String,
    pub discovery: String,
}
impl Default for Endpoints {
    fn default() -> Self {
        Self {
            issuer: ISSUER.into(),
            authorize: format!("{ISSUER}/api/accounts/authorize"),
            token: format!("{ISSUER}/api/accounts/oauth/token"),
            discovery: format!("{ISSUER}/.well-known/openid-configuration"),
        }
    }
}

#[derive(Deserialize)]
pub(super) struct Discovery {
    pub issuer: String,
    pub jwks_uri: String,
    pub revocation_endpoint: Option<String>,
}

#[derive(Deserialize)]
pub(super) struct TokenResponse {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub id_token: Option<String>,
    pub token_type: String,
    pub expires_in: Option<u64>,
    pub exp: Option<u64>,
    pub scope: Option<String>,
    pub earliest_refresh_at: Option<Value>,
}

impl TokenResponse {
    pub fn session(self, now: i64, old: Option<&Session>) -> Result<Session, String> {
        if !self.token_type.eq_ignore_ascii_case("bearer")
            || self.access_token.is_empty()
            || self.access_token.len() > 131072
        {
            return Err("siwc_invalid_token_response".into());
        }
        let expires_at_ms = match (self.expires_in, self.exp) {
            (Some(seconds), _) if seconds > 0 && seconds <= 86400 => {
                now.checked_add((seconds as i64) * 1000)
            }
            (None, Some(seconds)) => i64::try_from(seconds)
                .ok()
                .and_then(|s| s.checked_mul(1000))
                .filter(|s| *s > now),
            _ => None,
        }
        .ok_or("siwc_invalid_token_expiry")?;
        Ok(Session {
            access_token: self.access_token,
            refresh_token: self.refresh_token.filter(|s| !s.is_empty()),
            id_token: self
                .id_token
                .or_else(|| old.and_then(|s| s.id_token.clone())),
            scopes: self
                .scope
                .map(|s| s.split_whitespace().map(str::to_owned).collect())
                .unwrap_or_else(|| old.map(|s| s.scopes.clone()).unwrap_or_default()),
            expires_at_ms,
            earliest_refresh_at: self.earliest_refresh_at,
            refresh_pending: false,
            refresh_retry_after_ms: None,
            extensions: old.map(|s| s.extensions.clone()).unwrap_or_default(),
        })
    }
}

#[derive(Clone, Deserialize)]
pub(super) struct Identity {
    pub sub: String,
    pub nonce: Option<String>,
    pub email: Option<String>,
    pub aud: Value,
    pub azp: Option<String>,
}

pub(super) fn verify_identity(
    token: &str,
    jwks: &JwkSet,
    issuer: &str,
    client: &str,
    nonce: Option<&str>,
) -> Result<Identity, String> {
    let header = decode_header(token).map_err(|_| "siwc_invalid_identity")?;
    if !matches!(
        header.alg,
        Algorithm::RS256 | Algorithm::ES256 | Algorithm::EdDSA
    ) {
        return Err("siwc_invalid_identity".into());
    }
    let kid = header.kid.ok_or("siwc_invalid_identity")?;
    let jwk = jwks.find(&kid).ok_or("siwc_unknown_signing_key")?;
    let key = DecodingKey::from_jwk(jwk).map_err(|_| "siwc_invalid_identity")?;
    let mut validation = Validation::new(header.alg);
    validation.set_issuer(&[issuer]);
    validation.set_audience(&[client]);
    validation.set_required_spec_claims(&["exp", "iss", "aud", "sub"]);
    validation.leeway = 0;
    validation.validate_nbf = true;
    let identity = decode::<Identity>(token, &key, &validation)
        .map_err(|_| "siwc_invalid_identity")?
        .claims;
    if identity.sub.is_empty()
        || nonce.is_some_and(|expected| identity.nonce.as_deref() != Some(expected))
        || identity.azp.as_deref().is_some_and(|azp| azp != client)
        || identity
            .aud
            .as_array()
            .is_some_and(|aud| aud.len() > 1 && identity.azp.as_deref() != Some(client))
    {
        return Err("siwc_invalid_identity".into());
    }
    Ok(identity)
}

pub(super) fn validate_endpoint(url: &str, endpoints: &Endpoints) -> Result<(), String> {
    let value = Url::parse(url).map_err(|_| "siwc_invalid_discovery")?;
    let issuer = Url::parse(&endpoints.issuer).map_err(|_| "siwc_invalid_discovery")?;
    if value.origin() != issuer.origin()
        || !value.username().is_empty()
        || value.password().is_some()
        || value.fragment().is_some()
    {
        return Err("siwc_invalid_discovery".into());
    }
    if value.scheme() != "https" {
        #[cfg(test)]
        if value.scheme() == "http" && value.host_str() == Some("127.0.0.1") {
            return Ok(());
        }
        return Err("siwc_invalid_discovery".into());
    }
    Ok(())
}

pub(super) async fn bounded_json<T: serde::de::DeserializeOwned>(
    response: reqwest::Response,
) -> Result<T, String> {
    if !response.status().is_success() {
        return Err(format!("siwc_http_{}", response.status().as_u16()));
    }
    bounded_document(response).await
}

pub(super) async fn bounded_document<T: serde::de::DeserializeOwned>(
    response: reqwest::Response,
) -> Result<T, String> {
    if response.content_length().is_some_and(|n| n > 262144) {
        return Err("siwc_response_too_large".into());
    }
    let mut response = response;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "siwc_network_error")? {
        if bytes.len() + chunk.len() > 262144 {
            return Err("siwc_response_too_large".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "siwc_invalid_response".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scheduling_metadata_stays_opaque_and_expiry_is_bounded() {
        let parsed: TokenResponse = serde_json::from_value(serde_json::json!({"access_token":"token", "token_type":"Bearer", "expires_in":3600,"earliest_refresh_at":"opaque"})).unwrap();
        let session = parsed.session(1000, None).unwrap();
        assert_eq!(session.expires_at_ms, 3601000);
        assert_eq!(
            session.earliest_refresh_at,
            Some(Value::String("opaque".into()))
        );
        assert!(validate_endpoint("https://attacker.example/keys", &Endpoints::default()).is_err());
        assert!(validate_endpoint(
            "https://auth.openai.com@attacker.example/keys",
            &Endpoints::default()
        )
        .is_err());
    }
}
