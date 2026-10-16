//! Server-owned origin context; it never crosses the caller's spawn payload.
use std::future::Future;

tokio::task_local! { static REMOTE_ORIGIN: String; }
/// Authenticated Host listener, never reconstructed from renderer environment values.
#[derive(Clone)]
pub struct GatewayAuthority {
    pub port: u16,
    pub device_id: Option<String>,
    pub task_id: String,
    /// Host-admitted immutable source; never decoded from the spawn payload.
    pub delivery_source: Option<DeliverySource>,
    pub authorized: std::sync::Arc<dyn Fn() -> bool + Send + Sync>,
}
/// Durable source authority issued by the Host before remote execution.
/// Origin references are owner-admitted labels, not credentials or authority.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeliverySource {
    pub version: u32,
    pub id: String,
    pub owner_account_id: String,
    pub host_id: String,
    pub task_id: String,
    pub device_id: String,
    pub conversation_id: String,
    pub coding_run_id: String,
    pub origin_run_ref: String,
    pub repository_url: String,
    pub base_ref: String,
    pub branch: String,
    pub credential_ref: Option<String>,
}

/// Declared during the original authenticated operation, never at handoff.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeliverySourceDeclaration {
    pub conversation_id: String,
    pub origin_run_ref: String,
}
pub const DELIVERY_SOURCE_ENV: &str = "COGNIA_DELIVERY_SOURCE";

tokio::task_local! { static GATEWAY: Option<GatewayAuthority>; }
pub async fn with_gateway<T>(
    authority: Option<GatewayAuthority>,
    future: impl Future<Output = T>,
) -> T {
    GATEWAY.scope(authority, future).await
}
pub fn gateway() -> Option<GatewayAuthority> {
    GATEWAY.try_with(Clone::clone).ok().flatten()
}

pub async fn with_remote_origin<T>(device_id: &str, future: impl Future<Output = T>) -> T {
    REMOTE_ORIGIN.scope(device_id.to_owned(), future).await
}

pub fn current_origin() -> Option<String> {
    REMOTE_ORIGIN.try_with(Clone::clone).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn origin_is_scoped_and_not_inherited_by_unrelated_tasks() {
        assert_eq!(current_origin(), None);
        with_remote_origin("device-a", async {
            assert_eq!(current_origin().as_deref(), Some("device-a"));
            assert_eq!(
                tokio::spawn(async { current_origin() }).await.unwrap(),
                None
            );
        })
        .await;
        assert_eq!(current_origin(), None);
    }
}
