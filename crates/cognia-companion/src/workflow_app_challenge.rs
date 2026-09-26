//! Adaptive, session-bound proof-of-work for anonymous Workflow Apps.
//!
//! Normal users never see a challenge. A signed browser session receives a
//! small burst allowance; only sustained execution attempts activate the
//! challenge. A valid proof grants a short verified window. The challenge JWT
//! is bound to the exact app and session jti, so a solved token cannot be moved
//! across visitors or tenants.

use std::collections::HashMap;

use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

const CHALLENGE_SCOPE: &str = "workflow-app-anonymous-challenge";
const WINDOW_SECONDS: i64 = 60;
const FREE_ATTEMPTS: u32 = 8;
const VERIFIED_SECONDS: i64 = 5 * 60;
const CHALLENGE_TTL_SECONDS: i64 = 2 * 60;
const BASE_DIFFICULTY: u8 = 10;
const MAX_DIFFICULTY: u8 = 12;
const MAX_TRACKED_SESSIONS: usize = 4_096;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnonymousChallengeOffer {
    pub challenge_token: String,
    pub difficulty: u8,
    pub algorithm: &'static str,
    pub expires_at: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct ChallengeClaims {
    scope: String,
    app_slug: String,
    session_jti: String,
    nonce: String,
    difficulty: u8,
    iat: i64,
    exp: i64,
}

#[derive(Clone, Debug)]
struct SessionRisk {
    window_started_at: i64,
    attempts: u32,
    strikes: u8,
    verified_until: i64,
    last_seen_at: i64,
}

static SESSION_RISK: Lazy<Mutex<HashMap<String, SessionRisk>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn leading_zero_bits(bytes: &[u8]) -> u32 {
    let mut total = 0;
    for byte in bytes {
        if *byte == 0 {
            total += 8;
        } else {
            total += byte.leading_zeros();
            break;
        }
    }
    total
}

fn proof_valid(token: &str, proof: &str, difficulty: u8) -> bool {
    if proof.is_empty() || proof.len() > 32 || !proof.bytes().all(|byte| byte.is_ascii_digit()) {
        return false;
    }
    let digest = Sha256::digest(format!("{token}:{proof}").as_bytes());
    leading_zero_bits(&digest) >= u32::from(difficulty)
}

fn verify_offer(
    secret: &[u8],
    app_slug: &str,
    session_jti: &str,
    token: &str,
    proof: &str,
    now: i64,
) -> bool {
    let mut validation = Validation::new(Algorithm::HS256);
    validation.leeway = 0;
    validation.validate_exp = false;
    validation.set_required_spec_claims(&["exp"]);
    let Ok(decoded) =
        decode::<ChallengeClaims>(token, &DecodingKey::from_secret(secret), &validation)
    else {
        return false;
    };
    let claims = decoded.claims;
    claims.scope == CHALLENGE_SCOPE
        && claims.app_slug == app_slug
        && claims.session_jti == session_jti
        && claims.exp >= now
        && (BASE_DIFFICULTY..=MAX_DIFFICULTY).contains(&claims.difficulty)
        && proof_valid(token, proof, claims.difficulty)
}

fn issue_offer(
    secret: &[u8],
    app_slug: &str,
    session_jti: &str,
    difficulty: u8,
    now: i64,
) -> Result<AnonymousChallengeOffer, String> {
    let expires_at = now + CHALLENGE_TTL_SECONDS;
    let claims = ChallengeClaims {
        scope: CHALLENGE_SCOPE.into(),
        app_slug: app_slug.into(),
        session_jti: session_jti.into(),
        nonce: Uuid::new_v4().to_string(),
        difficulty,
        iat: now,
        exp: expires_at,
    };
    let challenge_token = encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(secret),
    )
    .map_err(|error| format!("issue anonymous challenge: {error}"))?;
    Ok(AnonymousChallengeOffer {
        challenge_token,
        difficulty,
        algorithm: "sha256-leading-zero-bits",
        expires_at,
    })
}

/// Admit a normal anonymous mutation or return a challenge offer.
pub fn admit(
    secret: &[u8],
    app_slug: &str,
    session_jti: &str,
    challenge_token: Option<&str>,
    challenge_proof: Option<&str>,
    now: i64,
) -> Result<(), AnonymousChallengeOffer> {
    let key = format!("{app_slug}:{session_jti}");
    let mut risk = SESSION_RISK.lock();
    if risk.len() >= MAX_TRACKED_SESSIONS {
        risk.retain(|_, entry| now - entry.last_seen_at <= VERIFIED_SECONDS);
    }
    if !risk.contains_key(&key) && risk.len() >= MAX_TRACKED_SESSIONS {
        let oldest = risk
            .iter()
            .min_by_key(|(_, entry)| entry.last_seen_at)
            .map(|(key, _)| key.clone());
        if let Some(oldest) = oldest {
            risk.remove(&oldest);
        }
    }
    let entry = risk.entry(key).or_insert(SessionRisk {
        window_started_at: now,
        attempts: 0,
        strikes: 0,
        verified_until: 0,
        last_seen_at: now,
    });
    entry.last_seen_at = now;
    if entry.verified_until > now {
        return Ok(());
    }
    if now - entry.window_started_at >= WINDOW_SECONDS {
        entry.window_started_at = now;
        entry.attempts = 0;
        entry.strikes = entry.strikes.saturating_sub(1);
    }
    entry.attempts = entry.attempts.saturating_add(1);
    if entry.attempts <= FREE_ATTEMPTS {
        return Ok(());
    }

    if let (Some(token), Some(proof)) = (challenge_token, challenge_proof) {
        if verify_offer(secret, app_slug, session_jti, token, proof, now) {
            entry.verified_until = now + VERIFIED_SECONDS;
            entry.attempts = 0;
            super::metrics::record_workflow_app_challenge(true);
            return Ok(());
        }
        entry.strikes = entry.strikes.saturating_add(1);
    }
    let difficulty =
        BASE_DIFFICULTY.saturating_add(entry.strikes.min(MAX_DIFFICULTY - BASE_DIFFICULTY));
    drop(risk);
    super::metrics::record_workflow_app_challenge(false);
    Err(
        issue_offer(secret, app_slug, session_jti, difficulty, now).unwrap_or_else(|_| {
            AnonymousChallengeOffer {
                challenge_token: String::new(),
                difficulty,
                algorithm: "sha256-leading-zero-bits",
                expires_at: now,
            }
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    static TEST_SESSION_RISK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

    fn solve(token: &str, difficulty: u8) -> String {
        (0_u64..)
            .find(|proof| proof_valid(token, &proof.to_string(), difficulty))
            .unwrap()
            .to_string()
    }

    #[test]
    fn challenge_activates_after_a_burst_and_grants_a_verified_window() {
        let _guard = TEST_SESSION_RISK.lock();
        let secret = b"challenge-secret";
        let session = Uuid::new_v4().to_string();
        for _ in 0..FREE_ATTEMPTS {
            assert!(admit(secret, "review", &session, None, None, 100).is_ok());
        }
        let offer = admit(secret, "review", &session, None, None, 100).unwrap_err();
        assert_eq!(offer.difficulty, BASE_DIFFICULTY);
        let proof = solve(&offer.challenge_token, offer.difficulty);
        assert!(admit(
            secret,
            "review",
            &session,
            Some(&offer.challenge_token),
            Some(&proof),
            101,
        )
        .is_ok());
        assert!(admit(secret, "review", &session, None, None, 102).is_ok());
    }

    #[test]
    fn proof_is_bound_to_signature_app_and_session() {
        let secret = b"challenge-secret";
        let session = Uuid::new_v4().to_string();
        let offer = issue_offer(secret, "review", &session, BASE_DIFFICULTY, 100).unwrap();
        let proof = solve(&offer.challenge_token, offer.difficulty);
        assert!(verify_offer(
            secret,
            "review",
            &session,
            &offer.challenge_token,
            &proof,
            101
        ));
        assert!(!verify_offer(
            b"wrong-secret",
            "review",
            &session,
            &offer.challenge_token,
            &proof,
            101
        ));
        assert!(!verify_offer(
            secret,
            "other-app",
            &session,
            &offer.challenge_token,
            &proof,
            101
        ));
        assert!(!verify_offer(
            secret,
            "review",
            "other-session",
            &offer.challenge_token,
            &proof,
            101
        ));
    }

    #[test]
    fn tracked_session_risk_never_exceeds_the_declared_cap() {
        let _guard = TEST_SESSION_RISK.lock();
        SESSION_RISK.lock().clear();
        for index in 0..=MAX_TRACKED_SESSIONS {
            assert!(admit(
                b"challenge-secret",
                "review",
                &format!("session-{index}"),
                None,
                None,
                100,
            )
            .is_ok());
        }
        assert_eq!(SESSION_RISK.lock().len(), MAX_TRACKED_SESSIONS);
        SESSION_RISK.lock().clear();
    }
}
