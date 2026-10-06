//! Real push dispatchers. Implementations of
//! [`super::push::PushDispatcher`]:
//!
//! - [`FcmDispatcher`] — Firebase Cloud Messaging HTTP v1.
//! - [`ApnsDispatcher`] — Apple Push Notification service over HTTP/2.
//! - [`HmsDispatcher`] — Huawei Push Kit HTTP v1 for Android without GMS.
//!
//! All expect their credentials loaded at construction time. The current
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
#[derive(Debug, Clone, Deserialize, Serialize)]
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
        let http = managed_client(Client::builder(), GOOGLE_OAUTH_URL)
            .map_err(|error| format!("FCM token client init: {error}"))?;
        let resp = http
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
    async fn deliver(&self, record: &PushTokenRecord, payload: &PushPayload) -> DeliveryOutcome {
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
        let http = match managed_client(Client::builder(), &url) {
            Ok(http) => http,
            Err(error) => {
                log::warn!("FCM HTTP client init: {error}");
                return DeliveryOutcome::Failed;
            }
        };
        let resp = http
            .post(&url)
            .bearer_auth(&bearer)
            .header("content-type", "application/json")
            .body(message.to_string())
            .send()
            .await;
        match resp {
            Ok(r) if r.status().is_success() => DeliveryOutcome::Sent,
            Ok(r) => {
                log::warn!(
                    "FCM deliver {}: {}",
                    r.status(),
                    r.text().await.unwrap_or_default()
                );
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
// Huawei Push Kit (Android HMS) HTTP v1
// ---------------------------------------------------------------------------

#[derive(Clone, Deserialize, Serialize)]
pub struct HmsCredentials {
    pub app_id: String,
    pub client_secret: String,
}

impl HmsCredentials {
    pub fn validate(&self) -> Result<(), String> {
        if self.app_id.is_empty()
            || self.app_id.len() > 64
            || !self.app_id.bytes().all(|c| c.is_ascii_digit())
        {
            return Err("Huawei app ID must be a numeric AppGallery Connect client ID".into());
        }
        if self.client_secret.trim().is_empty() {
            return Err("Huawei client secret is required".into());
        }
        Ok(())
    }
}

pub struct HmsDispatcher {
    creds: HmsCredentials,
    // Serializes OAuth refreshes across concurrent notifications without a
    // parking_lot guard crossing an await point.
    token_cache: tokio::sync::Mutex<Option<HmsBearer>>,
    oauth_url: String,
    send_url: String,
}

struct HmsBearer {
    token: String,
    expires_at: Instant,
}

#[derive(Deserialize)]
struct HmsTokenResponse {
    access_token: String,
    expires_in: u64,
}

impl HmsDispatcher {
    pub fn new(creds: HmsCredentials) -> Result<Arc<Self>, String> {
        creds.validate()?;
        Ok(Arc::new(Self {
            send_url: format!(
                "https://push-api.cloud.huawei.com/v1/{}/messages:send",
                creds.app_id
            ),
            oauth_url: "https://oauth-login.cloud.huawei.com/oauth2/v3/token".into(),
            creds,
            token_cache: tokio::sync::Mutex::new(None),
        }))
    }

    async fn bearer(&self) -> Result<String, String> {
        let mut cache = self.token_cache.lock().await;
        if let Some(cached) = cache.as_ref() {
            if Instant::now() < cached.expires_at {
                return Ok(cached.token.clone());
            }
        }
        let client = managed_client(
            Client::builder().timeout(Duration::from_secs(15)),
            &self.oauth_url,
        )?;
        let response = client
            .post(&self.oauth_url)
            .form(&[
                ("grant_type", "client_credentials"),
                ("client_id", self.creds.app_id.as_str()),
                ("client_secret", self.creds.client_secret.as_str()),
            ])
            .send()
            .await
            .map_err(|_| "Huawei OAuth transport failed".to_string())?;
        if !response.status().is_success() {
            // Never log upstream bodies: they may echo submitted secrets.
            return Err(format!("Huawei OAuth returned HTTP {}", response.status()));
        }
        let body: HmsTokenResponse = response
            .json()
            .await
            .map_err(|_| "Invalid Huawei OAuth response".to_string())?;
        if body.access_token.is_empty() || body.expires_in == 0 {
            return Err("Huawei OAuth returned an empty or expired token".into());
        }
        let lifetime = body.expires_in.min(3600);
        *cache = Some(HmsBearer {
            token: body.access_token.clone(),
            expires_at: Instant::now() + Duration::from_secs(lifetime.saturating_sub(60)),
        });
        Ok(body.access_token)
    }
}

fn hms_message(record: &PushTokenRecord, payload: &PushPayload) -> serde_json::Value {
    let mut data = payload.data.clone();
    data.insert("title".into(), json!(payload.title));
    data.insert("body".into(), json!(payload.body));
    json!({"validate_only": false, "message": {
        "token": [&record.token],
        "data": serde_json::Value::Object(data).to_string(),
        "android": {"notification": {
            "foreground_show": false,
            "title": payload.title.as_deref().unwrap_or("Cognia"),
            "body": payload.body.as_deref().unwrap_or_default(),
            "click_action": {"type": 1, "action": "com.cognia.mobile.HUAWEI_PUSH"}
        }}
    }})
}

fn hms_outcome(response: &serde_json::Value, token: &str) -> DeliveryOutcome {
    match response["code"].as_str() {
        Some("80000000") => DeliveryOutcome::Sent,
        Some("80300007") => DeliveryOutcome::InvalidToken,
        Some("80100000") => {
            let details = response["msg"]
                .as_str()
                .and_then(|msg| serde_json::from_str::<serde_json::Value>(msg).ok());
            if details
                .as_ref()
                .and_then(|v| v["illegal_tokens"].as_array())
                .is_some_and(|tokens| tokens.iter().any(|value| value.as_str() == Some(token)))
            {
                DeliveryOutcome::InvalidToken
            } else {
                DeliveryOutcome::Failed
            }
        }
        _ => DeliveryOutcome::Failed,
    }
}

#[async_trait]
impl PushDispatcher for HmsDispatcher {
    async fn deliver(&self, record: &PushTokenRecord, payload: &PushPayload) -> DeliveryOutcome {
        if record.provider != super::push::PushProvider::Hms {
            return DeliveryOutcome::Failed;
        }
        let client = match managed_client(
            Client::builder().timeout(Duration::from_secs(15)),
            &self.send_url,
        ) {
            Ok(client) => client,
            Err(_) => return DeliveryOutcome::Failed,
        };
        let message = hms_message(record, payload);
        // Retry only explicit authentication failures; retrying transport errors
        // could deliver a notification twice after an ambiguous timeout.
        for attempt in 0..2 {
            let bearer = match self.bearer().await {
                Ok(token) => token,
                Err(error) => {
                    log::warn!("{error}");
                    return DeliveryOutcome::Failed;
                }
            };
            let response = match client
                .post(&self.send_url)
                .bearer_auth(&bearer)
                .json(&message)
                .send()
                .await
            {
                Ok(response) => response,
                Err(_) => {
                    log::warn!("Huawei push transport failed");
                    return DeliveryOutcome::Failed;
                }
            };
            let status = response.status();
            let body = response
                .json::<serde_json::Value>()
                .await
                .unwrap_or_default();
            if status == reqwest::StatusCode::UNAUTHORIZED
                || matches!(body["code"].as_str(), Some("80200001" | "80200003"))
            {
                let mut cache = self.token_cache.lock().await;
                if cache.as_ref().is_some_and(|entry| entry.token == bearer) {
                    *cache = None;
                }
                drop(cache);
                if attempt == 0 {
                    continue;
                }
            }
            let outcome = hms_outcome(&body, &record.token);
            if !status.is_success() && !matches!(outcome, DeliveryOutcome::InvalidToken) {
                return DeliveryOutcome::Failed;
            }
            if matches!(outcome, DeliveryOutcome::Failed) {
                log::warn!("Huawei push rejected (HTTP {status})");
            }
            return outcome;
        }
        DeliveryOutcome::Failed
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
}

#[derive(Debug, Serialize)]
struct ApnsJwtClaims<'a> {
    iss: &'a str,
    iat: u64,
}

impl ApnsDispatcher {
    #[allow(dead_code)]
    pub fn new(creds: ApnsCredentials) -> Result<Arc<Self>, String> {
        Ok(Arc::new(Self { creds }))
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
    async fn deliver(&self, record: &PushTokenRecord, payload: &PushPayload) -> DeliveryOutcome {
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
        // HTTP/2 is mandatory for APNs over token auth. Build per delivery so
        // a settings change cannot leave a stale direct/proxy client cached.
        let http = match managed_client(Client::builder().http2_prior_knowledge(), &url) {
            Ok(http) => http,
            Err(error) => {
                log::warn!("APNs HTTP client init: {error}");
                return DeliveryOutcome::Failed;
            }
        };
        let resp = http
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
                log::warn!(
                    "APNs deliver {}: {}",
                    r.status(),
                    r.text().await.unwrap_or_default()
                );
                DeliveryOutcome::Failed
            }
            Err(err) => {
                log::warn!("APNs transport: {err}");
                DeliveryOutcome::Failed
            }
        }
    }
}

/// Thin adapter over the shared helper — the dispatchers report failures as
/// `String`, and this keeps the conversion in one place rather than at each of
/// the three call sites.
fn managed_client(builder: reqwest::ClientBuilder, target: &str) -> Result<Client, String> {
    cognia_net::proxy_config::managed_client(builder, target).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hms_test_server(
        responses: Vec<&'static str>,
    ) -> (String, std::thread::JoinHandle<Vec<String>>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(10);
            let mut requests = Vec::new();
            for response in responses {
                let mut stream = loop {
                    match listener.accept() {
                        Ok((stream, _)) => break stream,
                        Err(error)
                            if error.kind() == std::io::ErrorKind::WouldBlock
                                && Instant::now() < deadline =>
                        {
                            std::thread::sleep(Duration::from_millis(5))
                        }
                        Err(error) => panic!("mock accept failed: {error}"),
                    }
                };
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut bytes = Vec::new();
                loop {
                    let mut buf = [0; 4096];
                    let len = stream.read(&mut buf).unwrap();
                    assert!(len > 0);
                    bytes.extend_from_slice(&buf[..len]);
                    if let Some(header_end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&bytes[..header_end]).to_lowercase();
                        let length: usize = headers
                            .lines()
                            .find_map(|line| line.strip_prefix("content-length:").map(str::trim))
                            .unwrap()
                            .parse()
                            .unwrap();
                        if bytes.len() >= header_end + 4 + length {
                            break;
                        }
                    }
                }
                requests.push(String::from_utf8(bytes).unwrap());
                let status = if response.contains("80300007") {
                    "400 Bad Request"
                } else {
                    "200 OK"
                };
                write!(stream, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", response.len(), response).unwrap();
            }
            requests
        });
        (url, handle)
    }

    #[tokio::test]
    async fn hms_refreshes_rejected_bearer_and_reuses_new_token() {
        cognia_net::proxy_config::apply_current(Default::default()).unwrap();
        let (url, server) = hms_test_server(vec![
            r#"{"access_token":"old","expires_in":3600}"#,
            r#"{"code":"80200003"}"#,
            r#"{"access_token":"new","expires_in":3600}"#,
            r#"{"code":"80000000"}"#,
            r#"{"code":"80300007"}"#,
        ]);
        let dispatcher = HmsDispatcher {
            creds: HmsCredentials {
                app_id: "123456".into(),
                client_secret: "a+b&c".into(),
            },
            token_cache: tokio::sync::Mutex::new(None),
            oauth_url: format!("{url}/oauth"),
            send_url: format!("{url}/push"),
        };
        let record = PushTokenRecord {
            device_id: "phone".into(),
            provider: super::super::push::PushProvider::Hms,
            token: "token".into(),
            app_version: None,
            device_locale: None,
            registered_at: 0,
        };
        let payload = PushPayload {
            title: None,
            body: None,
            data: Default::default(),
        };
        dispatcher.bearer().await.expect("mock OAuth exchange");
        assert!(matches!(
            dispatcher.deliver(&record, &payload).await,
            DeliveryOutcome::Sent
        ));
        assert!(matches!(
            dispatcher.deliver(&record, &payload).await,
            DeliveryOutcome::InvalidToken
        ));
        let requests = server.join().unwrap();
        assert!(requests[0].contains("client_secret=a%2Bb%26c"));
        assert!(requests[1].contains("Bearer old"));
        assert!(requests[3].contains("Bearer new"));
        assert!(requests[4].contains("Bearer new"));
    }

    #[test]
    fn hms_credentials_reject_empty_secret_and_url_injection() {
        assert!(HmsDispatcher::new(HmsCredentials {
            app_id: "../evil".into(),
            client_secret: "secret".into()
        })
        .is_err());
        assert!(HmsDispatcher::new(HmsCredentials {
            app_id: "123".into(),
            client_secret: " ".into()
        })
        .is_err());
    }

    #[test]
    fn hms_payload_carries_notification_and_tap_route() {
        let record = PushTokenRecord {
            device_id: "phone".into(),
            provider: super::super::push::PushProvider::Hms,
            token: "huawei-token".into(),
            app_version: None,
            device_locale: None,
            registered_at: 0,
        };
        let payload = PushPayload {
            title: Some("Cognia".into()),
            body: Some("Ready".into()),
            data: serde_json::from_value(json!({"sessionId": "session-1"})).unwrap(),
        };
        let message = hms_message(&record, &payload);
        assert_eq!(message["message"]["token"], json!(["huawei-token"]));
        assert_eq!(
            message["message"]["android"]["notification"]["click_action"]["action"],
            "com.cognia.mobile.HUAWEI_PUSH"
        );
        assert_eq!(
            message["message"]["android"]["notification"]["foreground_show"],
            false
        );
        let data: serde_json::Value =
            serde_json::from_str(message["message"]["data"].as_str().unwrap()).unwrap();
        assert_eq!(data["sessionId"], "session-1");
        assert_eq!(data["title"], "Cognia");
    }

    #[test]
    fn hms_service_failure_is_not_http_success() {
        assert!(matches!(
            hms_outcome(&json!({"code":"80000000"}), "token"),
            DeliveryOutcome::Sent
        ));
        assert!(matches!(
            hms_outcome(&json!({"code":"80300007"}), "token"),
            DeliveryOutcome::InvalidToken
        ));
        assert!(matches!(
            hms_outcome(&json!({"code":"80300002"}), "token"),
            DeliveryOutcome::Failed
        ));
        assert!(matches!(
            hms_outcome(&json!({}), "token"),
            DeliveryOutcome::Failed
        ));
        assert!(matches!(
            hms_outcome(
                &json!({"code":"80100000", "msg":"{\"illegal_tokens\":[\"token\"]}"}),
                "token"
            ),
            DeliveryOutcome::InvalidToken
        ));
    }

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
