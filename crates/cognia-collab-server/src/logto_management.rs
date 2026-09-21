//! The server's door into Logto's Management API.
//!
//! # Why this lives on the server and nowhere else
//!
//! Creating an organization and adding a person to it are the two Logto
//! mutations account bootstrap needs, and both need a machine-to-machine
//! credential with `all` on the management resource. That credential is the
//! keys to the identity provider. It never reaches a renderer, a phone, or the
//! CLI: the client asks THIS service to enrol it, and this service is the only
//! process that holds the M2M secret.
//!
//! # Shape
//!
//! A trait, so the route tests run against [`FakeLogtoManagement`] and the
//! binary against [`HttpLogtoManagement`]. [`UnconfiguredLogtoManagement`] is
//! what a deployment gets when the credential is absent: every call refuses
//! with a message naming the variable to set, rather than a 500 with no clue.
//!
//! Endpoints (Logto Management API, verified 2026-09-02):
//!
//! - token: `POST {endpoint}/oidc/token`, `client_credentials`, HTTP Basic
//!   with the M2M app id/secret, `resource=https://default.logto.app/api`,
//!   `scope=all`
//! - `POST /api/organizations { name }` → `{ id }`
//! - `POST /api/organizations/{id}/users { userIds }`
//! - `POST /api/organizations/{id}/users/{userId}/roles { organizationRoleNames }`
//! - `GET /api/users/{id}` → `{ identities: { <connector target>: { userId, details } } }`,
//!   read so a GitHub or Feishu login can be joined to the person the IM
//!   adapters already know (ADR-0149 section 3).

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use parking_lot::Mutex;
use serde::Deserialize;

#[derive(Debug, thiserror::Error)]
pub enum LogtoManagementError {
    #[error("Logto management is not configured: {0}")]
    NotConfigured(String),
    #[error("Logto management token request failed: {0}")]
    Token(String),
    #[error("Logto management request failed: {0}")]
    Request(String),
    #[error("Logto management answered {status}: {body}")]
    Rejected { status: u16, body: String },
    #[error("Logto management answered with an unreadable body: {0}")]
    Malformed(String),
}

/// One social identity Logto holds for a user: the connector target it came
/// through and the provider's own id for the person.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalIdentityClaim {
    /// The connector target, e.g. `github`, `feishu-web`. Clients map it.
    pub provider: String,
    /// The provider's stable id: GitHub's numeric user id, Feishu's union id
    /// when the connector recorded one, else its open id.
    pub subject: String,
    /// The provider-side tenant, when the provider has them (Feishu's tenant key).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tenant: Option<String>,
    /// A display label the connector recorded, for rosters.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

/// Read the identities out of a Logto user record. Pure, and tolerant: a
/// provider whose details carry no usable id is left out rather than invented.
pub fn identities_from_user(user: &serde_json::Value) -> Vec<ExternalIdentityClaim> {
    let Some(identities) = user.get("identities").and_then(|value| value.as_object()) else {
        return Vec::new();
    };
    let text = |value: Option<&serde_json::Value>| -> Option<String> {
        value
            .and_then(|value| match value {
                serde_json::Value::String(text) => Some(text.clone()),
                serde_json::Value::Number(number) => Some(number.to_string()),
                _ => None,
            })
            .map(|text| text.trim().to_owned())
            .filter(|text| !text.is_empty())
    };
    let mut claims = Vec::new();
    for (target, identity) in identities {
        let details = identity.get("details");
        let detail = |key: &str| text(details.and_then(|details| details.get(key)));
        // Feishu's union id is stable across the apps of one tenant, the open
        // id only within one app. Logto's `userId` is whatever the connector
        // chose, so the explicit union id wins when it is there.
        let subject = if target.starts_with("feishu") || target == "lark" {
            detail("unionId")
                .or_else(|| detail("union_id"))
                .or_else(|| text(identity.get("userId")))
                .or_else(|| detail("openId"))
                .or_else(|| detail("open_id"))
        } else {
            text(identity.get("userId")).or_else(|| detail("id"))
        };
        let Some(subject) = subject else { continue };
        let tenant = detail("tenantKey").or_else(|| detail("tenant_key"));
        let label = detail("name")
            .or_else(|| detail("login"))
            .or_else(|| detail("nickname"))
            .or_else(|| detail("email"));
        claims.push(ExternalIdentityClaim {
            provider: target.clone(),
            subject,
            tenant,
            label,
        });
    }
    claims
}

#[async_trait]
pub trait LogtoManagement: Send + Sync {
    /// Create an organization and return Logto's id for it.
    async fn create_organization(&self, name: &str) -> Result<String, LogtoManagementError>;

    /// The social identities Logto holds for a user (its `sub`). A deployment
    /// without management access answers with none: the join is a nicety, and
    /// sign-in must not depend on it.
    async fn get_user_identities(
        &self,
        logto_user_id: &str,
    ) -> Result<Vec<ExternalIdentityClaim>, LogtoManagementError>;

    /// Add a Logto user to an organization. Idempotent on Logto's side.
    async fn add_organization_user(
        &self,
        organization_id: &str,
        user_id: &str,
    ) -> Result<(), LogtoManagementError>;

    /// Assign an organization role by NAME. Names are what an operator
    /// configures and reads in the console. Ids are per-deployment noise.
    async fn assign_organization_role(
        &self,
        organization_id: &str,
        user_id: &str,
        role_name: &str,
    ) -> Result<(), LogtoManagementError>;
}

/// The deployment has no M2M credential. Every call says so.
pub struct UnconfiguredLogtoManagement;

#[async_trait]
impl LogtoManagement for UnconfiguredLogtoManagement {
    async fn create_organization(&self, _name: &str) -> Result<String, LogtoManagementError> {
        Err(not_configured())
    }
    async fn add_organization_user(&self, _: &str, _: &str) -> Result<(), LogtoManagementError> {
        Err(not_configured())
    }
    async fn assign_organization_role(
        &self,
        _: &str,
        _: &str,
        _: &str,
    ) -> Result<(), LogtoManagementError> {
        Err(not_configured())
    }
    async fn get_user_identities(
        &self,
        _: &str,
    ) -> Result<Vec<ExternalIdentityClaim>, LogtoManagementError> {
        Ok(Vec::new())
    }
}

fn not_configured() -> LogtoManagementError {
    LogtoManagementError::NotConfigured(
        "set COLLAB_LOGTO_ENDPOINT, COLLAB_LOGTO_M2M_CLIENT_ID and COLLAB_LOGTO_M2M_CLIENT_SECRET"
            .into(),
    )
}

/// Configuration for [`HttpLogtoManagement`].
#[derive(Clone)]
pub struct LogtoManagementConfig {
    /// Logto's public base, e.g. `https://auth.example.com`. NOT the `/oidc` issuer.
    pub endpoint: String,
    pub client_id: String,
    pub client_secret: String,
    /// The management API resource indicator. `https://default.logto.app/api` on OSS.
    pub resource: String,
}

impl std::fmt::Debug for LogtoManagementConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LogtoManagementConfig")
            .field("endpoint", &self.endpoint)
            .field("client_id", &self.client_id)
            .field("client_secret", &"<redacted>")
            .field("resource", &self.resource)
            .finish()
    }
}

struct CachedToken {
    value: String,
    expires_at: Instant,
}

pub struct HttpLogtoManagement {
    config: LogtoManagementConfig,
    client: reqwest::Client,
    token: Mutex<Option<CachedToken>>,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    expires_in: Option<u64>,
}

#[derive(Deserialize)]
struct CreatedOrganization {
    id: String,
}

impl HttpLogtoManagement {
    pub fn new(config: LogtoManagementConfig) -> anyhow::Result<Self> {
        crate::store::ensure_crypto_provider();
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(15))
            .build()?;
        Ok(Self {
            config,
            client,
            token: Mutex::new(None),
        })
    }

    fn base(&self) -> String {
        self.config.endpoint.trim_end_matches('/').to_owned()
    }

    async fn access_token(&self) -> Result<String, LogtoManagementError> {
        if let Some(cached) = self.token.lock().as_ref() {
            // A minute of margin: a token that expires mid-saga would turn a
            // clean "idp_applied" into a half-applied one.
            if cached.expires_at > Instant::now() + Duration::from_secs(60) {
                return Ok(cached.value.clone());
            }
        }
        let response = self
            .client
            .post(format!("{}/oidc/token", self.base()))
            .basic_auth(&self.config.client_id, Some(&self.config.client_secret))
            .header("content-type", "application/x-www-form-urlencoded")
            .body(form_encode(&[
                ("grant_type", "client_credentials"),
                ("resource", self.config.resource.as_str()),
                ("scope", "all"),
            ]))
            .send()
            .await
            .map_err(|error| LogtoManagementError::Token(error.to_string()))?;
        let status = response.status();
        let body = response
            .text()
            .await
            .map_err(|error| LogtoManagementError::Token(error.to_string()))?;
        if !status.is_success() {
            return Err(LogtoManagementError::Token(format!("{status}: {body}")));
        }
        let parsed: TokenResponse = serde_json::from_str(&body)
            .map_err(|error| LogtoManagementError::Malformed(error.to_string()))?;
        let ttl = Duration::from_secs(parsed.expires_in.unwrap_or(300));
        *self.token.lock() = Some(CachedToken {
            value: parsed.access_token.clone(),
            expires_at: Instant::now() + ttl,
        });
        Ok(parsed.access_token)
    }

    async fn get_json(&self, path: &str) -> Result<String, LogtoManagementError> {
        let token = self.access_token().await?;
        let response = self
            .client
            .get(format!("{}{path}", self.base()))
            .bearer_auth(token)
            .send()
            .await
            .map_err(|error| LogtoManagementError::Request(error.to_string()))?;
        let status = response.status();
        let text = response
            .text()
            .await
            .map_err(|error| LogtoManagementError::Request(error.to_string()))?;
        if !status.is_success() {
            if status.as_u16() == 401 {
                *self.token.lock() = None;
            }
            return Err(LogtoManagementError::Rejected {
                status: status.as_u16(),
                body: text,
            });
        }
        Ok(text)
    }

    async fn post_json(
        &self,
        path: &str,
        body: &serde_json::Value,
    ) -> Result<String, LogtoManagementError> {
        let token = self.access_token().await?;
        let response = self
            .client
            .post(format!("{}{path}", self.base()))
            .bearer_auth(token)
            .json(body)
            .send()
            .await
            .map_err(|error| LogtoManagementError::Request(error.to_string()))?;
        let status = response.status();
        let text = response
            .text()
            .await
            .map_err(|error| LogtoManagementError::Request(error.to_string()))?;
        if !status.is_success() {
            // A stale cached token is the one rejection worth retrying, once.
            if status.as_u16() == 401 {
                *self.token.lock() = None;
            }
            return Err(LogtoManagementError::Rejected {
                status: status.as_u16(),
                body: text,
            });
        }
        Ok(text)
    }
}

#[async_trait]
impl LogtoManagement for HttpLogtoManagement {
    async fn create_organization(&self, name: &str) -> Result<String, LogtoManagementError> {
        let body = self
            .post_json("/api/organizations", &serde_json::json!({ "name": name }))
            .await?;
        let created: CreatedOrganization = serde_json::from_str(&body)
            .map_err(|error| LogtoManagementError::Malformed(error.to_string()))?;
        Ok(created.id)
    }

    async fn add_organization_user(
        &self,
        organization_id: &str,
        user_id: &str,
    ) -> Result<(), LogtoManagementError> {
        self.post_json(
            &format!("/api/organizations/{organization_id}/users"),
            &serde_json::json!({ "userIds": [user_id] }),
        )
        .await
        .map(drop)
    }

    async fn assign_organization_role(
        &self,
        organization_id: &str,
        user_id: &str,
        role_name: &str,
    ) -> Result<(), LogtoManagementError> {
        self.post_json(
            &format!("/api/organizations/{organization_id}/users/{user_id}/roles"),
            &serde_json::json!({ "organizationRoleNames": [role_name] }),
        )
        .await
        .map(drop)
    }

    async fn get_user_identities(
        &self,
        logto_user_id: &str,
    ) -> Result<Vec<ExternalIdentityClaim>, LogtoManagementError> {
        let encoded: String = logto_user_id
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
            .collect();
        if encoded.is_empty() || encoded != logto_user_id {
            return Err(LogtoManagementError::Request(
                "Logto user id contains characters this client does not send".into(),
            ));
        }
        let text = self.get_json(&format!("/api/users/{encoded}")).await?;
        let user: serde_json::Value = serde_json::from_str(&text)
            .map_err(|error| LogtoManagementError::Malformed(error.to_string()))?;
        Ok(identities_from_user(&user))
    }
}

/// `application/x-www-form-urlencoded`, by hand. The resource indicator is a
/// URL, so the encoder has to be a real one rather than a join on `&`.
fn form_encode(pairs: &[(&str, &str)]) -> String {
    fn encode(value: &str) -> String {
        let mut out = String::with_capacity(value.len());
        for byte in value.bytes() {
            match byte {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                    out.push(byte as char)
                }
                b' ' => out.push('+'),
                other => out.push_str(&format!("%{other:02X}")),
            }
        }
        out
    }
    pairs
        .iter()
        .map(|(key, value)| format!("{}={}", encode(key), encode(value)))
        .collect::<Vec<_>>()
        .join("&")
}

/// What a fake records, so a test can assert the saga touched Logto in order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LogtoCall {
    CreateOrganization {
        name: String,
    },
    AddUser {
        organization_id: String,
        user_id: String,
    },
    AssignRole {
        organization_id: String,
        user_id: String,
        role_name: String,
    },
    GetUserIdentities {
        user_id: String,
    },
}

/// In-memory double for the route tests.
#[derive(Default)]
pub struct FakeLogtoManagement {
    calls: Mutex<Vec<LogtoCall>>,
    /// `org name -> id`, so a repeated create is visible as a second org.
    organizations: Mutex<BTreeMap<String, Vec<String>>>,
    /// When set, every mutation fails with this message. For saga tests.
    failure: Mutex<Option<String>>,
    /// When set, the NEXT `add_organization_user` fails, once. For the
    /// "organization created, membership not yet" resume path.
    fail_next_add_user: Mutex<bool>,
    next_id: Mutex<u32>,
    /// `logto user id -> identities`, what `GET /api/users/{id}` would say.
    identities: Mutex<BTreeMap<String, Vec<ExternalIdentityClaim>>>,
}

impl FakeLogtoManagement {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn calls(&self) -> Vec<LogtoCall> {
        self.calls.lock().clone()
    }

    pub fn fail_with(&self, message: &str) {
        *self.failure.lock() = Some(message.to_owned());
    }

    pub fn set_identities(&self, logto_user_id: &str, identities: Vec<ExternalIdentityClaim>) {
        self.identities
            .lock()
            .insert(logto_user_id.to_owned(), identities);
    }

    pub fn recover(&self) {
        *self.failure.lock() = None;
    }

    pub fn fail_next_add_user(&self) {
        *self.fail_next_add_user.lock() = true;
    }

    /// Every organization id ever created under `name`.
    pub fn organizations_named(&self, name: &str) -> Vec<String> {
        self.organizations
            .lock()
            .get(name)
            .cloned()
            .unwrap_or_default()
    }

    fn check(&self) -> Result<(), LogtoManagementError> {
        match self.failure.lock().as_ref() {
            Some(message) => Err(LogtoManagementError::Request(message.clone())),
            None => Ok(()),
        }
    }
}

#[async_trait]
impl LogtoManagement for FakeLogtoManagement {
    async fn create_organization(&self, name: &str) -> Result<String, LogtoManagementError> {
        self.check()?;
        self.calls.lock().push(LogtoCall::CreateOrganization {
            name: name.to_owned(),
        });
        let mut next = self.next_id.lock();
        *next += 1;
        let id = format!("lorg_{}", *next);
        self.organizations
            .lock()
            .entry(name.to_owned())
            .or_default()
            .push(id.clone());
        Ok(id)
    }

    async fn add_organization_user(
        &self,
        organization_id: &str,
        user_id: &str,
    ) -> Result<(), LogtoManagementError> {
        self.check()?;
        if std::mem::take(&mut *self.fail_next_add_user.lock()) {
            return Err(LogtoManagementError::Request(
                "membership call failed".into(),
            ));
        }
        self.calls.lock().push(LogtoCall::AddUser {
            organization_id: organization_id.to_owned(),
            user_id: user_id.to_owned(),
        });
        Ok(())
    }

    async fn assign_organization_role(
        &self,
        organization_id: &str,
        user_id: &str,
        role_name: &str,
    ) -> Result<(), LogtoManagementError> {
        self.check()?;
        self.calls.lock().push(LogtoCall::AssignRole {
            organization_id: organization_id.to_owned(),
            user_id: user_id.to_owned(),
            role_name: role_name.to_owned(),
        });
        Ok(())
    }

    async fn get_user_identities(
        &self,
        logto_user_id: &str,
    ) -> Result<Vec<ExternalIdentityClaim>, LogtoManagementError> {
        self.check()?;
        self.calls.lock().push(LogtoCall::GetUserIdentities {
            user_id: logto_user_id.to_owned(),
        });
        Ok(self
            .identities
            .lock()
            .get(logto_user_id)
            .cloned()
            .unwrap_or_default())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn the_unconfigured_port_names_the_variables_to_set() {
        let error = UnconfiguredLogtoManagement
            .create_organization("Acme")
            .await
            .unwrap_err();
        assert!(error.to_string().contains("COLLAB_LOGTO_M2M_CLIENT_ID"));
    }

    #[tokio::test]
    async fn the_fake_records_calls_in_order_and_can_be_made_to_fail() {
        let fake = FakeLogtoManagement::new();
        let org = fake.create_organization("Acme").await.unwrap();
        fake.add_organization_user(&org, "u1").await.unwrap();
        fake.assign_organization_role(&org, "u1", "owner")
            .await
            .unwrap();
        assert_eq!(
            fake.calls(),
            vec![
                LogtoCall::CreateOrganization {
                    name: "Acme".into()
                },
                LogtoCall::AddUser {
                    organization_id: org.clone(),
                    user_id: "u1".into()
                },
                LogtoCall::AssignRole {
                    organization_id: org.clone(),
                    user_id: "u1".into(),
                    role_name: "owner".into()
                },
            ]
        );
        assert_eq!(fake.organizations_named("Acme"), vec![org]);

        fake.fail_with("idp down");
        assert!(matches!(
            fake.create_organization("Acme").await,
            Err(LogtoManagementError::Request(message)) if message == "idp down"
        ));
        fake.recover();
        assert!(fake.create_organization("Acme").await.is_ok());
        assert_eq!(fake.organizations_named("Acme").len(), 2);
    }

    #[test]
    fn the_form_encoder_escapes_a_resource_url() {
        assert_eq!(
            form_encode(&[
                ("grant_type", "client_credentials"),
                ("resource", "https://default.logto.app/api"),
                ("scope", "all"),
            ]),
            "grant_type=client_credentials&resource=https%3A%2F%2Fdefault.logto.app%2Fapi&scope=all"
        );
        assert_eq!(form_encode(&[("a b", "c&d")]), "a+b=c%26d");
    }

    #[test]
    fn the_http_port_builds_with_a_plain_config() {
        let port = HttpLogtoManagement::new(LogtoManagementConfig {
            endpoint: "https://auth.example.com/".into(),
            client_id: "m2m".into(),
            client_secret: "secret".into(),
            resource: "https://default.logto.app/api".into(),
        })
        .unwrap();
        // The endpoint is the Logto base, and a trailing slash is not a path.
        assert_eq!(port.base(), "https://auth.example.com");
    }

    #[test]
    fn identities_are_read_from_a_logto_user_record() {
        let user = serde_json::json!({
            "id": "logto-ada",
            "identities": {
                "github": { "userId": "12345", "details": { "login": "ada", "id": 12345 } },
                "feishu-web": {
                    "userId": "ou_open",
                    "details": { "openId": "ou_open", "unionId": "on_union", "tenantKey": "tk_1", "name": "Ada" }
                },
                "google": { "userId": "", "details": {} }
            }
        });
        let mut claims = identities_from_user(&user);
        claims.sort_by(|a, b| a.provider.cmp(&b.provider));
        assert_eq!(
            claims,
            vec![
                ExternalIdentityClaim {
                    provider: "feishu-web".into(),
                    subject: "on_union".into(),
                    tenant: Some("tk_1".into()),
                    label: Some("Ada".into()),
                },
                ExternalIdentityClaim {
                    provider: "github".into(),
                    subject: "12345".into(),
                    tenant: None,
                    label: Some("ada".into()),
                },
            ]
        );
        assert!(identities_from_user(&serde_json::json!({ "id": "x" })).is_empty());
    }

    #[tokio::test]
    async fn an_unconfigured_deployment_holds_no_identities_and_the_fake_replays_them() {
        assert_eq!(
            UnconfiguredLogtoManagement
                .get_user_identities("logto-ada")
                .await
                .unwrap(),
            Vec::<ExternalIdentityClaim>::new()
        );
        let fake = FakeLogtoManagement::new();
        fake.set_identities(
            "logto-ada",
            vec![ExternalIdentityClaim {
                provider: "github".into(),
                subject: "1".into(),
                tenant: None,
                label: None,
            }],
        );
        assert_eq!(
            fake.get_user_identities("logto-ada").await.unwrap().len(),
            1
        );
        assert!(fake.get_user_identities("nobody").await.unwrap().is_empty());
        assert!(matches!(
            fake.calls().last(),
            Some(LogtoCall::GetUserIdentities { user_id }) if user_id == "nobody"
        ));
    }
}
