use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::Context;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use hmac::{Hmac, Mac};
use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use uuid::Uuid;

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GrantRole {
    Uploader,
    Viewer,
    Triager,
    Admin,
}

impl GrantRole {
    pub fn permits(self, required: Self) -> bool {
        let rank = |role| match role {
            Self::Uploader => 0,
            Self::Viewer => 1,
            Self::Triager => 2,
            Self::Admin => 3,
        };
        rank(self) >= rank(required)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantClaims {
    pub grant_id: Uuid,
    pub tenant_id: Uuid,
    pub project_id: Uuid,
    pub installation_id: String,
    pub role: GrantRole,
    /// The human behind a console grant — the OIDC `sub`.
    ///
    /// `None` for installation-proof grants, which are issued to a machine and
    /// have no operator to name. Every audit event written by a route that
    /// mutates triage or reaches raw artifacts carries this, which is what
    /// makes `audit_events.actor_id` answerable.
    ///
    /// `#[serde(default)]` so a grant minted before this field existed still
    /// verifies for the remainder of its 15-minute TTL instead of logging the
    /// whole fleet out on deploy.
    #[serde(default)]
    pub actor_id: Option<String>,
    pub issued_at: i64,
    pub expires_at: i64,
}

#[derive(Clone)]
pub struct GrantSigner {
    key: Vec<u8>,
}

impl GrantSigner {
    pub fn new(key: &[u8]) -> anyhow::Result<Self> {
        if key.len() < 32 {
            anyhow::bail!("grant signing key must contain at least 32 bytes");
        }
        Ok(Self { key: key.to_vec() })
    }

    pub fn issue(
        &self,
        tenant_id: Uuid,
        project_id: Uuid,
        installation_id: String,
        role: GrantRole,
        actor_id: Option<String>,
        ttl: Duration,
    ) -> anyhow::Result<String> {
        let issued_at = unix_now()?;
        let claims = GrantClaims {
            grant_id: Uuid::new_v4(),
            tenant_id,
            project_id,
            installation_id,
            role,
            actor_id,
            issued_at,
            expires_at: issued_at + ttl.as_secs() as i64,
        };
        let payload = serde_json::to_vec(&claims)?;
        let encoded = URL_SAFE_NO_PAD.encode(payload);
        let mut mac = HmacSha256::new_from_slice(&self.key)?;
        mac.update(encoded.as_bytes());
        Ok(format!(
            "{encoded}.{}",
            URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
        ))
    }

    pub fn verify(&self, token: &str) -> anyhow::Result<GrantClaims> {
        let (payload, signature) = token.split_once('.').context("malformed upload grant")?;
        let signature = URL_SAFE_NO_PAD
            .decode(signature)
            .context("malformed upload grant signature")?;
        let mut mac = HmacSha256::new_from_slice(&self.key)?;
        mac.update(payload.as_bytes());
        mac.verify_slice(&signature)
            .context("invalid upload grant signature")?;
        let claims: GrantClaims = serde_json::from_slice(
            &URL_SAFE_NO_PAD
                .decode(payload)
                .context("malformed upload grant claims")?,
        )?;
        if claims.expires_at < unix_now()? {
            anyhow::bail!("upload grant expired");
        }
        Ok(claims)
    }
}

#[derive(Debug, Deserialize)]
struct OidcClaims {
    sub: String,
    exp: usize,
    tenant_id: Uuid,
    project_id: Uuid,
    #[serde(default)]
    role: Option<GrantRole>,
}

pub fn verify_oidc_session(
    token: &str,
    issuer: &str,
    audience: &str,
    public_key_pem: &str,
) -> anyhow::Result<(Uuid, Uuid, String, GrantRole)> {
    let mut validation = Validation::new(Algorithm::RS256);
    validation.set_issuer(&[issuer]);
    validation.set_audience(&[audience]);
    let token = decode::<OidcClaims>(
        token,
        &DecodingKey::from_rsa_pem(public_key_pem.as_bytes())?,
        &validation,
    )?;
    let _expiry_verified_by_jsonwebtoken = token.claims.exp;
    Ok((
        token.claims.tenant_id,
        token.claims.project_id,
        token.claims.sub,
        token.claims.role.unwrap_or(GrantRole::Uploader),
    ))
}

pub fn verify_installation_signature(
    public_key: &[u8],
    signature: &[u8],
    message: &[u8],
) -> anyhow::Result<()> {
    let public_key: [u8; 32] = public_key
        .try_into()
        .map_err(|_| anyhow::anyhow!("installation public key must contain 32 bytes"))?;
    let signature = Signature::from_slice(signature)?;
    VerifyingKey::from_bytes(&public_key)?
        .verify(message, &signature)
        .context("invalid installation signature")
}

pub fn validate_request_timestamp(timestamp: i64, tolerance: Duration) -> anyhow::Result<()> {
    let now = unix_now()?;
    if timestamp.abs_diff(now) > tolerance.as_secs() {
        anyhow::bail!("installation proof timestamp outside allowed window");
    }
    Ok(())
}

fn unix_now() -> anyhow::Result<i64> {
    Ok(SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    #[test]
    fn signed_grants_are_scoped_and_expire() {
        let signer = GrantSigner::new(&[7; 32]).unwrap();
        let tenant_id = Uuid::new_v4();
        let project_id = Uuid::new_v4();
        let token = signer
            .issue(
                tenant_id,
                project_id,
                "install-a".into(),
                GrantRole::Uploader,
                None,
                Duration::from_secs(60),
            )
            .unwrap();
        let claims = signer.verify(&token).unwrap();
        assert_eq!(claims.tenant_id, tenant_id);
        assert_eq!(claims.project_id, project_id);
        assert_eq!(claims.installation_id, "install-a");
        assert_eq!(claims.actor_id, None);
        assert!(signer.verify(&(token + "x")).is_err());
    }

    #[test]
    fn console_grants_carry_the_operator_through_to_the_audit_trail() {
        let signer = GrantSigner::new(&[9; 32]).unwrap();
        let token = signer
            .issue(
                Uuid::new_v4(),
                Uuid::new_v4(),
                "console".into(),
                GrantRole::Triager,
                Some("ops@example.com".to_owned()),
                Duration::from_secs(60),
            )
            .unwrap();
        assert_eq!(
            signer.verify(&token).unwrap().actor_id.as_deref(),
            Some("ops@example.com")
        );
    }

    #[test]
    fn a_grant_minted_before_actor_id_existed_still_verifies() {
        // The field is additive, and grants live 15 minutes. Rejecting the
        // older shape would log every in-flight console out on deploy.
        let signer = GrantSigner::new(&[5; 32]).unwrap();
        let legacy = serde_json::json!({
            "grantId": Uuid::new_v4(),
            "tenantId": Uuid::new_v4(),
            "projectId": Uuid::new_v4(),
            "installationId": "install-legacy",
            "role": "viewer",
            "issuedAt": unix_now().unwrap(),
            "expiresAt": unix_now().unwrap() + 60,
        });
        let encoded = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&legacy).unwrap());
        let mut mac = HmacSha256::new_from_slice(&signer.key).unwrap();
        mac.update(encoded.as_bytes());
        let token = format!(
            "{encoded}.{}",
            URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
        );
        let claims = signer.verify(&token).unwrap();
        assert_eq!(claims.actor_id, None);
        assert_eq!(claims.role, GrantRole::Viewer);
    }

    #[test]
    fn verifies_installation_public_key_proof() {
        let signing_key = SigningKey::from_bytes(&[3; 32]);
        let message = b"tenant\nproject\ninstallation\nnonce\n123";
        let signature = signing_key.sign(message);
        verify_installation_signature(
            signing_key.verifying_key().as_bytes(),
            &signature.to_bytes(),
            message,
        )
        .unwrap();
        assert!(verify_installation_signature(
            signing_key.verifying_key().as_bytes(),
            &signature.to_bytes(),
            b"different"
        )
        .is_err());
    }

    #[test]
    fn role_order_prevents_uploader_from_reading_console_data() {
        assert!(!GrantRole::Uploader.permits(GrantRole::Viewer));
        assert!(GrantRole::Admin.permits(GrantRole::Triager));
    }
}
