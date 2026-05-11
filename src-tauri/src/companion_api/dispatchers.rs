//! Real push dispatchers (Phase B3). Two implementations of
//! [`super::push::PushDispatcher`]:
//!
//! - [`FcmDispatcher`] — Firebase Cloud Messaging HTTP v1.
//! - [`ApnsDispatcher`] — Apple Push Notification service over HTTP/2.
//!
//! Both expect their credentials loaded at construction time. The current
//! token-management story is minimal: FCM bearer tokens are cached for one
//! hour with a stamp, APNs provider JWTs are re-signed on every call (cheap;
//! Apple recommends rotating no faster than 20 min and JWT signing is sub-ms).
//! Cred-rotation UX lands separately in Phase B2.

use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use parking_lot::Mutex;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::push::{DeliveryOutcome, PushDispatcher, PushPayload, PushTokenRecord};

// ---------------------------------------------------------------------------
// FCM credentials & dispatcher
// ---------------------------------------------------------------------------

/// Service-account JSON downloaded from the Google Cloud Console (Service
/// Accounts → Keys → Create new key → JSON). Only the four fields we need.
#[derive(Debug, Clone, Deserialize)]
pub struct FcmServiceAccount {
    pub client_email: String,
    pub private_key: String,
    pub project_id: String,
    #[allow(dead_code)] // kept for diagnostics surface in B2 UI.
    pub private_key_id: Option<String>,
}

/// FCM HTTP v1 dispatcher. POSTs to
/// `https://fcm.googleapis.com/v1/projects/<project>/messages:send`.
#[allow(dead_code)] // used via the dyn PushDispatcher trait in the trigger wiring.
pub struct FcmDispatcher {
    creds: FcmServiceAccount,
    http: Client,
    token_cache: Mutex<Option<CachedBearer>>,
}

struct CachedBearer {
    token: String,
    fetched_at: Instant,
}

const FCM_TOKEN_TTL: Duration = Duration::from_secs(3600);
const FCM_TOKEN_GRACE: Duration = Duration::from_secs(300);
const GOOGLE_OAUTH_URL: &str = "https://oauth2.googleapis.com/token";

#[derive(Debug, Serialize)]
struct GoogleJwtClaims<'a> {
    iss: &'a str,
    scope: &'a str,
    aud: &'a str,
    exp: u64,
    iat: u64,
}

#[derive(Debug, Deserialize)]
struct GoogleTokenResponse {
    access_token: String,
    #[allow(dead_code)]
    expires_in: u64,
}

impl FcmDispatcher {
    #[allow(dead_code)] // constructed from settings UI in B2.
    pub fn new(creds: FcmServiceAccount) -> Arc<Self> {
        Arc::new(Self {
            creds,
            http: Client::new(),
            token_cache: Mutex::new(None),
        })
    }

    async fn bearer(&self) -> Result<String, String> {
        if let Some(c) = self.token_cache.lock().as_ref() {
            if c.fetched_at.elapsed() < FCM_TOKEN_TTL - FCM_TOKEN_GRACE {
                return Ok(c.token.clone());
            }
        }
        let now = chrono::Utc::now().timestamp() as u64;
        let claims = GoogleJwtClaims {
            iss: &self.creds.client_email,
            scope: "https://www.googleapis.com/auth/firebase.messaging",
            aud: GOOGLE_OAUTH_URL,
            iat: now,
            exp: now + 3600,
        };
        let key = EncodingKey::from_rsa_pem(self.creds.private_key.as_bytes())
            .map_err(|e| format!("invalid FCM private key: {e}"))?;
        let assertion = encode(&Header::new(Algorithm::RS256), &claims, &key)
            .map_err(|e| format!("FCM JWT sign failed: {e}"))?;

        let body = format!(
            "grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion={}",
            assertion
        );
        let resp = self
            .http
            .post(GOOGLE_OAUTH_URL)
            .header("content-type", "application/x-www-form-urlencoded")
            .body(body)
            .send()
            .await
            .map_err(|e| format!("FCM token exchange transport error: {e}"))?;
        if !resp.status().is_success() {
            let s = resp.status();
            let t = resp.text().await.unwrap_or_default();
            return Err(format!("FCM token exchange {s}: {t}"));
        }
        let body: GoogleTokenResponse = resp
            .json()
            .await
            .map_err(|e| format!("FCM token parse: {e}"))?;
        *self.token_cache.lock() = Some(CachedBearer {
            token: body.access_token.clone(),
            fetched_at: Instant::now(),
        });
        Ok(body.access_token)
    }
}

#[async_trait]
impl PushDispatcher for FcmDispatcher {
    async fn deliver(
        &self,
        record: &PushTokenRecord,
        payload: &PushPayload,
    ) -> DeliveryOutcome {
        let bearer = match self.bearer().await {
            Ok(b) => b,
            Err(err) => {
                log::warn!("FCM bearer fetch failed: {err}");
                return DeliveryOutcome::Failed;
            }
        };
        let url = format!(
            "https://fcm.googleapis.com/v1/projects/{}/messages:send",
            self.creds.project_id
        );
        let mut message = json!({
            "message": {
                "token": record.token,
                "notification": {
                    "title": payload.title.clone().unwrap_or_default(),
                    "body": payload.body.clone().unwrap_or_default(),
                }
            }
        });
        if !payload.data.is_empty() {
            // FCM v1 requires string-valued data fields.
            let data_strings: serde_json::Map<String, serde_json::Value> = payload
                .data
                .iter()
                .map(|(k, v)| {
                    let s = match v {
                        serde_json::Value::String(s) => s.clone(),
                        other => other.to_string(),
                    };
                    (k.clone(), serde_json::Value::String(s))
                })
                .collect();
            message["message"]["data"] = serde_json::Value::Object(data_strings);
        }
        let resp = self
            .http
            .post(&url)
            .bearer_auth(&bearer)
            .header("content-type", "application/json")
            .body(message.to_string())
            .send()
            .await;
        match resp {
            Ok(r) if r.status().is_success() => DeliveryOutcome::Sent,
            Ok(r) => {
                log::warn!("FCM deliver {}: {}", r.status(), r.text().await.unwrap_or_default());
                DeliveryOutcome::Failed
            }
            Err(err) => {
                log::warn!("FCM transport: {err}");
                DeliveryOutcome::Failed
            }
        }
    }
}

// ---------------------------------------------------------------------------
// APNs credentials & dispatcher
// ---------------------------------------------------------------------------

/// APNs token-based auth credentials. Get the `.p8` key + identifiers from
/// developer.apple.com → Certificates / Identifiers & Profiles → Keys.
#[derive(Debug, Clone, Deserialize)]
pub struct ApnsCredentials {
    /// 10-character key identifier (e.g. "ABC1234DEF").
    pub key_id: String,
    /// 10-character team identifier.
    pub team_id: String,
    /// App's bundle identifier (e.g. "com.cognia.mobile").
    pub bundle_id: String,
    /// PEM-formatted ES256 `.p8` key contents.
    pub private_key_pem: String,
    /// When false, sends to `api.sandbox.push.apple.com` instead of
    /// `api.push.apple.com`.
    #[serde(default)]
    pub production: bool,
}

#[allow(dead_code)] // used via the dyn PushDispatcher trait in the trigger wiring.
pub struct ApnsDispatcher {
    creds: ApnsCredentials,
    http: Client,
}

#[derive(Debug, Serialize)]
struct ApnsJwtClaims<'a> {
    iss: &'a str,
    iat: u64,
}

impl ApnsDispatcher {
    #[allow(dead_code)]
    pub fn new(creds: ApnsCredentials) -> Result<Arc<Self>, String> {
        // HTTP/2 is mandatory for APNs over token auth.
        let http = Client::builder()
            .http2_prior_knowledge()
            .build()
            .map_err(|e| format!("APNs HTTP client init: {e}"))?;
        Ok(Arc::new(Self { creds, http }))
    }

    fn sign_jwt(&self) -> Result<String, String> {
        let now = chrono::Utc::now().timestamp() as u64;
        let claims = ApnsJwtClaims {
            iss: &self.creds.team_id,
            iat: now,
        };
        let mut header = Header::new(Algorithm::ES256);
        header.kid = Some(self.creds.key_id.clone());
        let key = EncodingKey::from_ec_pem(self.creds.private_key_pem.as_bytes())
            .map_err(|e| format!("invalid APNs .p8 key: {e}"))?;
        encode(&header, &claims, &key).map_err(|e| format!("APNs JWT sign: {e}"))
    }

    fn base_url(&self) -> &'static str {
        if self.creds.production {
            "https://api.push.apple.com"
        } else {
            "https://api.sandbox.push.apple.com"
        }
    }
}

#[async_trait]
impl PushDispatcher for ApnsDispatcher {
    async fn deliver(
        &self,
        record: &PushTokenRecord,
        payload: &PushPayload,
    ) -> DeliveryOutcome {
        let jwt = match self.sign_jwt() {
            Ok(t) => t,
            Err(err) => {
                log::warn!("APNs JWT sign failed: {err}");
                return DeliveryOutcome::Failed;
            }
        };
        let url = format!("{}/3/device/{}", self.base_url(), record.token);
        let mut aps_alert = serde_json::Map::new();
        if let Some(title) = payload.title.as_ref() {
            aps_alert.insert("title".into(), serde_json::Value::String(title.clone()));
        }
        if let Some(body) = payload.body.as_ref() {
            aps_alert.insert("body".into(), serde_json::Value::String(body.clone()));
        }
        let mut body = json!({
            "aps": {
                "alert": aps_alert,
                "sound": "default",
            }
        });
        if !payload.data.is_empty() {
            if let Some(obj) = body.as_object_mut() {
                for (k, v) in &payload.data {
                    obj.insert(k.clone(), v.clone());
                }
            }
        }
        let resp = self
            .http
            .post(&url)
            .bearer_auth(&jwt)
            .header("apns-topic", &self.creds.bundle_id)
            .header("apns-push-type", "alert")
            .header("content-type", "application/json")
            .body(body.to_string())
            .send()
            .await;
        match resp {
            Ok(r) if r.status().is_success() => DeliveryOutcome::Sent,
            Ok(r) => {
                log::warn!("APNs deliver {}: {}", r.status(), r.text().await.unwrap_or_default());
                DeliveryOutcome::Failed
            }
            Err(err) => {
                log::warn!("APNs transport: {err}");
                DeliveryOutcome::Failed
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fcm_dispatcher_constructs_with_creds() {
        let creds = FcmServiceAccount {
            client_email: "svc@example.com".into(),
            private_key: "fake".into(),
            project_id: "p".into(),
            private_key_id: None,
        };
        let d = FcmDispatcher::new(creds);
        // Cache starts empty.
        assert!(d.token_cache.lock().is_none());
    }

    #[test]
    fn apns_dispatcher_constructs_with_creds() {
        // A real .p8 starts with `-----BEGIN PRIVATE KEY-----`; we just want
        // the constructor + http2 builder to succeed here.
        let creds = ApnsCredentials {
            key_id: "ABC1234DEF".into(),
            team_id: "TEAM1234DE".into(),
            bundle_id: "com.cognia.mobile".into(),
            private_key_pem: "stub".into(),
            production: false,
        };
        let d = ApnsDispatcher::new(creds).expect("construct");
        assert_eq!(d.base_url(), "https://api.sandbox.push.apple.com");
    }

    #[test]
    fn apns_dispatcher_picks_production_endpoint() {
        let creds = ApnsCredentials {
            key_id: "k".into(),
            team_id: "t".into(),
            bundle_id: "b".into(),
            private_key_pem: "stub".into(),
            production: true,
        };
        let d = ApnsDispatcher::new(creds).expect("construct");
        assert_eq!(d.base_url(), "https://api.push.apple.com");
    }
}
