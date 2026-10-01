//! Server-owned origin context; it never crosses the caller's spawn payload.
use std::future::Future;

tokio::task_local! { static REMOTE_ORIGIN: String; }
/// Authenticated Host listener, never reconstructed from renderer environment values.
#[derive(Clone)]
pub struct GatewayAuthority {
    pub port: u16,
    pub device_id: Option<String>,
    pub task_id: String,
    pub authorized: std::sync::Arc<dyn Fn() -> bool + Send + Sync>,
}
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
