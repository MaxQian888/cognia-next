//! Explicit Host route inventory, including raw REST and nested routers.
//! `GatedByDispatch` routes either enter remote_execution or use the same
//! admission gate as route middleware AFTER their existing authentication.
//! Fleet/connector authentication routes are inventoried but deliberately not
//! mounted in multi-tenant mode: they cannot supply a tenant execution actor.
//! App sessions: workflow_app_api.rs::verify_session/session_for_slug verifies
//! signature, expiry and app slug. Dify/MCP keys are validated by
//! lib/workflow/apps/api-key-service.ts::authenticateWorkflowAppApiKey
//! (hash lookup, expiry, revocation, scope, app/account binding), called by
//! dify-bridge-service.ts::dispatch and mcp-service.ts::invokeWorkflowAppMcp.

use axum::{extract::{MatchedPath, Request, State}, middleware::Next,
    response::{IntoResponse, Response}, http::StatusCode};
use crate::{deployment::DeploymentMode, middleware::DeviceContext};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HostRouteClass {
    PublicAuth,
    TicketedSocket,
    /// Execution is intentionally dormant in multi-tenant mode: application
    /// sessions execute code in the Host brain, without sandbox placement.
    /// Reads retain their app authentication; execution needs a future
    /// sandbox-aware adapter before this intentional dormancy can be lifted.
    AppSession,
    GatedByDispatch,
}

pub struct HostRoute {
    pub path: &'static str,
    pub class: HostRouteClass,
    pub capability: Option<&'static str>,
    /// AppSession + execution is ALWAYS refused on a multi-tenant Host,
    /// even with a healthy sandbox pool. A pool does not isolate Host JS.
    pub execution: bool,
}

use HostRouteClass::*;
pub const HOST_ROUTES: &[HostRoute] = &[
    HostRoute { path: "/healthz", class: PublicAuth, capability: None, execution: false },
    HostRoute { path: "/livez", class: PublicAuth, capability: None, execution: false },
    HostRoute { path: "/readyz", class: PublicAuth, capability: None, execution: false },
    HostRoute { path: "/.well-known/agent-card.json", class: PublicAuth, capability: None, execution: false },
    HostRoute { path: "/metrics", class: GatedByDispatch, capability: Some("service.internal"), execution: false },
    HostRoute { path: "/operator/maintenance/backups", class: GatedByDispatch, capability: Some("service.internal"), execution: false },
    HostRoute { path: "/api/portal/bootstrap", class: AppSession, capability: None, execution: false },
    HostRoute { path: "/api/apps/{app_slug}/bootstrap", class: AppSession, capability: None, execution: false },
    HostRoute { path: "/api/apps/{app_slug}/embed-token", class: AppSession, capability: None, execution: false },
    HostRoute { path: "/api/apps/{app_slug}/runs", class: AppSession, capability: None, execution: true },
    HostRoute { path: "/api/apps/{app_slug}/runs/{run_id}", class: AppSession, capability: None, execution: false },
    HostRoute { path: "/api/apps/{app_slug}/runs/{run_id}/events", class: AppSession, capability: None, execution: false },
    HostRoute { path: "/api/apps/{app_slug}/runs/{run_id}/cancel", class: AppSession, capability: None, execution: false },
    HostRoute { path: "/api/apps/{app_slug}/chat-messages", class: AppSession, capability: None, execution: true },
    HostRoute { path: "/api/apps/{app_slug}/feedback", class: AppSession, capability: None, execution: false },
    HostRoute { path: "/api/apps/{app_slug}/runs/{run_id}/shares", class: AppSession, capability: None, execution: false },
    HostRoute { path: "/api/apps/{app_slug}/result-shares/{code}", class: AppSession, capability: None, execution: false },
    HostRoute { path: "/api/apps/{app_slug}/mcp", class: AppSession, capability: None, execution: true },
    HostRoute { path: "/api/apps/{app_slug}/batch-template", class: AppSession, capability: None, execution: false },
    HostRoute { path: "/api/apps/{app_slug}/batches/{job_id}", class: AppSession, capability: None, execution: false },
    HostRoute { path: "/api/apps/{app_slug}/batches/{job_id}/pause", class: AppSession, capability: None, execution: false },
    HostRoute { path: "/api/apps/{app_slug}/batches/{job_id}/resume", class: AppSession, capability: None, execution: true },
    HostRoute { path: "/api/apps/{app_slug}/batches/{job_id}/cancel", class: AppSession, capability: None, execution: false },
    HostRoute { path: "/api/apps/{app_slug}/batches/{job_id}/export", class: AppSession, capability: None, execution: false },
    HostRoute { path: "/api/apps/{app_slug}/human-input", class: AppSession, capability: None, execution: false },
    HostRoute { path: "/api/apps/{app_slug}/human-input/{request_id}/submit", class: AppSession, capability: None, execution: true },
    HostRoute { path: "/v1/workflows/run", class: AppSession, capability: None, execution: true },
    HostRoute { path: "/v1/workflows/run/{run_id}", class: AppSession, capability: None, execution: false },
    HostRoute { path: "/v1/workflows/tasks/{task_id}/stop", class: AppSession, capability: None, execution: false },
    HostRoute { path: "/v1/chat-messages", class: AppSession, capability: None, execution: true },
    HostRoute { path: "/v1/chat-messages/{task_id}/stop", class: AppSession, capability: None, execution: false },
    HostRoute { path: "/v1/conversations", class: AppSession, capability: None, execution: false },
    HostRoute { path: "/v1/messages", class: AppSession, capability: None, execution: false },
    HostRoute { path: "/v1/conversations/{conversation_id}/name", class: AppSession, capability: None, execution: false },
    HostRoute { path: "/v1/conversations/{conversation_id}", class: AppSession, capability: None, execution: false },
    HostRoute { path: "/v1/conversations/{conversation_id}/variables", class: AppSession, capability: None, execution: false },
    HostRoute { path: "/v1/messages/{message_id}/feedbacks", class: AppSession, capability: None, execution: false },
    HostRoute { path: "/v1/files/upload", class: AppSession, capability: None, execution: false },
    HostRoute { path: "/api/apps/{app_slug}/batches", class: AppSession, capability: None, execution: true },
    HostRoute { path: "/api/apps/{app_slug}/human-input/{request_id}/files", class: AppSession, capability: None, execution: false },
    HostRoute { path: "/api/whoami", class: GatedByDispatch, capability: Some("host.observe"), execution: false },
    HostRoute { path: "/api/catalog", class: GatedByDispatch, capability: Some("host.observe"), execution: false },
    HostRoute { path: "/api/environment/ports/{project}/{container}/{port}", class: GatedByDispatch, capability: Some("host.observe"), execution: false },
    HostRoute { path: "/api/environment/ports/{project}/{container}/{port}/", class: GatedByDispatch, capability: Some("host.observe"), execution: false },
    HostRoute { path: "/api/environment/ports/{project}/{container}/{port}/{*tail}", class: GatedByDispatch, capability: Some("host.observe"), execution: false },
    HostRoute { path: "/api/sandbox/previews", class: GatedByDispatch, capability: Some("host.observe"), execution: false },
    HostRoute { path: "/api/sandbox/previews/{grant}", class: GatedByDispatch, capability: Some("host.observe"), execution: false },
    HostRoute { path: "/api/sandbox/previews/{grant}/", class: GatedByDispatch, capability: Some("host.observe"), execution: false },
    HostRoute { path: "/api/sandbox/previews/{grant}/{*tail}", class: GatedByDispatch, capability: Some("host.observe"), execution: false },
    HostRoute { path: "/api/_rpc/{name}", class: GatedByDispatch, capability: None, execution: false },
    HostRoute { path: "/api/sessions/{session_id}/media/{hash}", class: GatedByDispatch, capability: Some("host.observe"), execution: false },
    HostRoute { path: "/api/operations/{operation_id}", class: GatedByDispatch, capability: Some("host.observe"), execution: false },
    HostRoute { path: "/api/workflow-deployments/{deployment_id}/runs", class: GatedByDispatch, capability: Some("workflow.run"), execution: true },
    HostRoute { path: "/api/workflow-runs/{run_id}", class: GatedByDispatch, capability: Some("workflow.run"), execution: false },
    HostRoute { path: "/api/workflow-runs/{run_id}/events", class: GatedByDispatch, capability: Some("workflow.run"), execution: false },
    HostRoute { path: "/api/workflow-runs/{run_id}/cancel", class: GatedByDispatch, capability: Some("workflow.run"), execution: false },
    HostRoute { path: "/a2a", class: GatedByDispatch, capability: None, execution: false },
    HostRoute { path: "/api/devices", class: GatedByDispatch, capability: Some("host.admin"), execution: false },
    HostRoute { path: "/api/devices/{device_id}", class: GatedByDispatch, capability: Some("host.admin"), execution: false },
    HostRoute { path: "/api/devices/{device_id}/suspend", class: GatedByDispatch, capability: Some("host.admin"), execution: false },
    HostRoute { path: "/api/devices/{device_id}/resume", class: GatedByDispatch, capability: Some("host.admin"), execution: false },
    HostRoute { path: "/api/devices/{device_id}/forget", class: GatedByDispatch, capability: Some("host.admin"), execution: false },
    HostRoute { path: "/api/devices/{device_id}/capabilities", class: GatedByDispatch, capability: Some("host.admin"), execution: false },
    HostRoute { path: "/api/invitations", class: GatedByDispatch, capability: Some("host.admin"), execution: false },
    HostRoute { path: "/api/worker-enrollments", class: GatedByDispatch, capability: Some("host.admin"), execution: false },
    HostRoute { path: "/api/policies", class: GatedByDispatch, capability: Some("host.admin"), execution: false },
    HostRoute { path: "/internal/bridge", class: GatedByDispatch, capability: Some("service.internal"), execution: false },
    HostRoute { path: "/internal/events", class: GatedByDispatch, capability: Some("service.internal"), execution: false },
    HostRoute { path: "/internal/_rpc/{name}", class: GatedByDispatch, capability: None, execution: false },
    HostRoute { path: "/internal/operations/{operation_id}", class: GatedByDispatch, capability: Some("service.internal"), execution: false },
    HostRoute { path: "/internal/persons", class: GatedByDispatch, capability: Some("service.internal"), execution: false },
    HostRoute { path: "/internal/persons/purge", class: GatedByDispatch, capability: Some("service.internal"), execution: false },
    // P6a operator aliases: the canonical /internal/_rpc dispatch gates them (service JWT).
    HostRoute { path: "/internal/org-credentials/{operation}", class: GatedByDispatch, capability: Some("service.internal"), execution: false },
    HostRoute { path: "/internal/org-agents/{operation}", class: GatedByDispatch, capability: Some("service.internal"), execution: false },
    HostRoute { path: "/internal/org-usage/{operation}", class: GatedByDispatch, capability: Some("service.internal"), execution: false },
    HostRoute { path: "/internal/catalog", class: GatedByDispatch, capability: Some("service.internal"), execution: false },
    HostRoute { path: "/operator/lark/admin", class: GatedByDispatch, capability: Some("service.internal"), execution: false },
    HostRoute { path: "/operator/lark/admin/{request_id}", class: GatedByDispatch, capability: Some("service.internal"), execution: false },
    HostRoute { path: "/ws/events", class: TicketedSocket, capability: None, execution: false },
    HostRoute { path: "/ws/acp", class: TicketedSocket, capability: None, execution: true },
    HostRoute { path: "/ws/browser/{session_id}", class: TicketedSocket, capability: None, execution: true },
    HostRoute { path: "/ws/terminal", class: TicketedSocket, capability: None, execution: true },
    HostRoute { path: "/ws/remote-desktop/{session_id}", class: TicketedSocket, capability: None, execution: true },
    HostRoute { path: "/ws/worker", class: TicketedSocket, capability: None, execution: true },
    HostRoute { path: "/ws/browser-companion", class: TicketedSocket, capability: None, execution: false },
    HostRoute { path: "/api/auth/config", class: PublicAuth, capability: None, execution: false },
    HostRoute { path: "/api/auth/device/challenge", class: PublicAuth, capability: None, execution: false },
    HostRoute { path: "/api/auth/device/register", class: PublicAuth, capability: None, execution: false },
    HostRoute { path: "/api/auth/worker/register", class: PublicAuth, capability: None, execution: false },
    HostRoute { path: "/api/auth/browser/register", class: PublicAuth, capability: None, execution: false },
    HostRoute { path: "/api/auth/token", class: PublicAuth, capability: None, execution: false },
    HostRoute { path: "/api/auth/socket-ticket", class: PublicAuth, capability: None, execution: false },
    HostRoute { path: "/ide/relay/{relay_id}", class: GatedByDispatch, capability: Some("workspace.read"), execution: true },
    HostRoute { path: "/ide/relay/{relay_id}/", class: GatedByDispatch, capability: Some("workspace.read"), execution: true },
    HostRoute { path: "/ide/relay/{relay_id}/{*tail}", class: GatedByDispatch, capability: Some("workspace.read"), execution: true },
    HostRoute { path: "/ide/content", class: GatedByDispatch, capability: Some("service.internal"), execution: false },
    HostRoute { path: "/ide/content/{handle_id}", class: GatedByDispatch, capability: Some("service.internal"), execution: false },
    HostRoute { path: "/api/fleet/hook", class: PublicAuth, capability: None, execution: false },
    HostRoute { path: "/api/fleet/opencode/commands", class: PublicAuth, capability: None, execution: false },
    HostRoute { path: "/api/fleet/opencode/commands/ack", class: PublicAuth, capability: None, execution: false },
    HostRoute { path: "/api/fleet/opencode/commands/nack", class: PublicAuth, capability: None, execution: false },
    HostRoute { path: "/connectors/health", class: PublicAuth, capability: None, execution: false },
    HostRoute { path: "/connectors/oauth/lark/callback", class: PublicAuth, capability: None, execution: false },
    HostRoute { path: "/connectors/oauth/connector/{kind}/callback", class: PublicAuth, capability: None, execution: false },
    HostRoute { path: "/connectors/oauth/docs/{provider}/callback", class: PublicAuth, capability: None, execution: false },
    HostRoute { path: "/connectors/internal/lark/app-avatar", class: PublicAuth, capability: None, execution: false },
    HostRoute { path: "/connectors/lark/app-avatar/{token}", class: PublicAuth, capability: None, execution: false },
    HostRoute { path: "/connectors/webhook/{adapter_type}/{adapter_id}", class: PublicAuth, capability: None, execution: false },
    HostRoute { path: "/connectors/ws/onebot/{adapter_id}", class: PublicAuth, capability: None, execution: false },
    HostRoute { path: "/integrations/lark/web/login", class: PublicAuth, capability: None, execution: false },
    HostRoute { path: "/integrations/lark/web/callback", class: PublicAuth, capability: None, execution: false },
    HostRoute { path: "/integrations/lark/workbench/resolve", class: PublicAuth, capability: None, execution: false },
    HostRoute { path: "/integrations/lark/entry/resolve", class: PublicAuth, capability: None, execution: false },
    HostRoute { path: "/integrations/lark/intent/{request_id}", class: PublicAuth, capability: None, execution: false },
    HostRoute { path: "/integrations/lark/shortcut/import", class: PublicAuth, capability: None, execution: false },
    HostRoute { path: "/integrations/lark/plus/create", class: PublicAuth, capability: None, execution: false },
    HostRoute { path: "/integrations/lark/jssdk/config", class: PublicAuth, capability: None, execution: false },
    HostRoute { path: "/integrations/mcp/oauth/callback", class: PublicAuth, capability: None, execution: false },
];

pub fn lookup(path: &str) -> Option<&'static HostRoute> {
    HOST_ROUTES.iter().find(|route| route.path == path)
}

pub(crate) fn execution_refused(route: &HostRoute, mode: DeploymentMode, enabled: bool, sandboxes: bool) -> bool {
    route.execution && (!enabled || (mode == DeploymentMode::MultiTenant
        && (route.class == AppSession || route.capability == Some("workflow.run") || !sandboxes)))
}

/// Axum exposes MatchedPath but no public router iterator. The source-pinned
/// test below is the registration audit; this is defense in depth for unknown
/// paths supplied by a runtime's merged router. Unknown surfaces never run.
pub async fn boundary(State(mode): State<DeploymentMode>, request: Request, next: Next) -> Response {
    if mode == DeploymentMode::MultiTenant {
        // Router fallbacks have no registered surface. Keep their existing
        // 404 (including removed legacy pairing URLs); registered routes from
        // a merged runtime DO have MatchedPath and must be classified below.
        let Some(path) = request.extensions().get::<MatchedPath>().map(MatchedPath::as_str) else {
            return next.run(request).await;
        };
        let Some(route) = lookup(path) else {
            return cognia_problem::Problem::with_status(StatusCode::FORBIDDEN, "host_surface_forbidden", "unclassified Host route").into_response();
        };
        if execution_refused(route, mode, crate::host_surface_gate::execution_enabled(), crate::environment_pool::installed().is_some()) {
            return cognia_problem::Problem::with_status(StatusCode::SERVICE_UNAVAILABLE, "execution_isolation_unavailable", "execution is unavailable").into_response();
        }
    } else if !crate::host_surface_gate::execution_enabled() {
        let path = request.extensions().get::<MatchedPath>().map(MatchedPath::as_str).unwrap_or("");
        if lookup(path).is_some_and(|route| route.execution) {
            return cognia_problem::Problem::with_status(StatusCode::SERVICE_UNAVAILABLE, "execution_isolation_unavailable", "execution is unavailable").into_response();
        }
    }
    next.run(request).await
}

/// The person sockets authenticate separately (live generation in their
/// handlers; events are filtered to the partition per frame). They are never
/// admitted as a service principal by the Host policy or any other internal
/// route; person RPC is gated at dispatch.
fn person_socket_exempt(path: &str, principal: Option<&DeviceContext>) -> bool {
    matches!(path, "/internal/bridge" | "/internal/events")
        && principal.is_some_and(|principal| principal.scope == "person-brain")
}

/// Installed inside device/owner/service authentication, so the identity is
/// already established. RPC adapters are gated later at command dispatch.
pub async fn admission(request: Request, next: Next) -> Response {
    if crate::deployment::deployment_mode() == DeploymentMode::SingleUser { return next.run(request).await; }
    let path = request.extensions().get::<MatchedPath>().map(MatchedPath::as_str).unwrap_or("");
    if person_socket_exempt(path, request.extensions().get::<DeviceContext>()) { return next.run(request).await; }
    if let Some(capability) = lookup(path).and_then(|route| route.capability) {
        let Some(principal) = request.extensions().get::<DeviceContext>() else {
            return cognia_problem::Problem::with_status(StatusCode::FORBIDDEN, "host_principal_unbound", "route authentication supplied no principal").into_response();
        };
        if let Err(error) = crate::host_surface_gate::authorize(capability, None, principal, None).await { return error.into_response(); }
    }
    next.run(request).await
}

/// Runs only AFTER require_loopback_operator has established local operator
/// authority. That authority is service scope, never a tenant device identity.
pub async fn operator_admission(request: Request, next: Next) -> Response {
    let principal = DeviceContext {
        device_id: "local-operator".into(),
        tenant_id: String::new(),
        scope: "service".into(),
        granted_scopes: vec![],
        authorization_capabilities: None,
    };
    if let Err(error) = crate::host_surface_gate::authorize("service.internal", None, &principal, None).await {
        return error.into_response();
    }
    next.run(request).await
}

#[cfg(test)]
mod tests {
    #[test]
    fn p4_workflow_brain_execution_is_unavailable_even_with_a_healthy_pool() {
        let route = lookup("/api/workflow-deployments/{deployment_id}/runs").unwrap();
        assert!(execution_refused(route, DeploymentMode::MultiTenant, true, true));
        assert!(!execution_refused(route, DeploymentMode::SingleUser, true, true));
    }
    use super::*;
    use std::collections::BTreeSet;

    fn registered(source: &str) -> BTreeSet<&str> {
        source.split(".route(").skip(1).filter_map(|tail| {
            let tail = tail.trim_start().strip_prefix('"')?;
            tail.split('"').next()
        }).collect()
    }

    #[test]
    fn every_registered_host_path_is_classified_exactly_once() {
        let server = include_str!("server.rs").split("fn build_router_for_mode(").nth(1).unwrap()
            .split("/// The largest bare error").next().unwrap();
        let api = include_str!("api.rs").split("pub fn router()").nth(1).unwrap()
            .split("/// Bumped").next().unwrap();
        let paths = registered(server).into_iter().chain(registered(api)).collect::<BTreeSet<_>>();
        for path in paths { assert!(lookup(path).is_some(), "unclassified route {path}"); }
        // Pin the concrete nested/runtime routers too. Axum's runtime
        // boundary still refuses unknown paths from any other implementation.
        for (prefix, source) in [
            ("", include_str!("../../cognia-companion-rpc/src/companion_runtime.rs")),
            ("", include_str!("../../cognia-fleet/src/routes.rs")),
            ("/connectors", include_str!("../../cognia-connectors/src/axum_app.rs")),
            ("/connectors", include_str!("../../cognia-connectors/src/ws_server.rs")),
            ("/integrations/lark", include_str!("lark_entry.rs")),
        ] {
            for path in registered(source) {
                assert!(lookup(&format!("{prefix}{path}")).is_some(), "unclassified nested route {prefix}{path}");
            }
        }
        for path in registered(include_str!("../../cognia-companion-rpc/src/headless.rs")) {
            let path = if path == "/oauth/callback" { format!("/integrations/mcp{path}") } else { path.to_string() };
            assert!(lookup(&path).is_some(), "unclassified headless route {path}");
        }
        let unique = HOST_ROUTES.iter().map(|route| route.path).collect::<BTreeSet<_>>();
        assert_eq!(unique.len(), HOST_ROUTES.len(), "duplicate route classification");
        for path in ["/ws/events", "/ws/acp", "/ws/browser/{session_id}", "/ws/terminal", "/ws/remote-desktop/{session_id}", "/ws/worker", "/ws/browser-companion"] {
            assert_eq!(lookup(path).unwrap().class, TicketedSocket);
        }
        let policy = crate::host_surface_policy::POLICY.as_ref().unwrap();
        for route in HOST_ROUTES.iter().filter(|route| route.class == GatedByDispatch) {
            if route.capability.is_some_and(|capability| policy.executes(capability)) {
                assert!(route.execution, "{} must respect executionCapabilities", route.path);
            }
        }
    }

    #[test]
    fn app_session_execution_is_dormant_in_multi_tenant_even_with_a_pool() {
        for route in HOST_ROUTES.iter().filter(|route| route.class == AppSession) {
            for pool in [false, true] {
                assert_eq!(execution_refused(route, DeploymentMode::MultiTenant, true, pool), route.execution, "{}", route.path);
                assert_eq!(execution_refused(route, DeploymentMode::MultiTenant, false, pool), route.execution);
                assert!(!execution_refused(route, DeploymentMode::SingleUser, true, pool));
                assert_eq!(execution_refused(route, DeploymentMode::SingleUser, false, pool), route.execution);
            }
        }
        for path in ["/api/apps/{app_slug}/runs", "/api/apps/{app_slug}/chat-messages", "/api/apps/{app_slug}/batches", "/api/apps/{app_slug}/batches/{job_id}/resume", "/api/apps/{app_slug}/human-input/{request_id}/submit", "/api/apps/{app_slug}/mcp", "/v1/workflows/run", "/v1/chat-messages"] {
            assert!(lookup(path).unwrap().execution, "{path}");
        }
    }

    #[test]
    fn control_plane_only_keeps_identity_catalog_devices_and_events_available() {
        for path in ["/api/whoami", "/api/catalog", "/api/devices", "/api/devices/{device_id}",
            "/api/devices/{device_id}/suspend", "/api/devices/{device_id}/resume",
            "/api/devices/{device_id}/forget", "/api/devices/{device_id}/capabilities",
            "/api/invitations", "/api/worker-enrollments", "/api/policies", "/api/auth/config",
            "/api/auth/socket-ticket", "/ws/events",
            "/internal/events", "/internal/catalog", "/metrics",
            "/api/workflow-runs/{run_id}", "/api/workflow-runs/{run_id}/events"] {
            let route = lookup(path).unwrap();
            assert!(!route.execution, "{path}");
            for mode in [DeploymentMode::SingleUser, DeploymentMode::MultiTenant] {
                assert!(!execution_refused(route, mode, false, false), "{mode:?}/{path}");
            }
        }
        for path in ["/ws/terminal", "/ws/acp", "/ws/browser/{session_id}", "/ws/worker", "/ws/remote-desktop/{session_id}",
            "/api/workflow-deployments/{deployment_id}/runs"] {
            assert!(execution_refused(lookup(path).unwrap(), DeploymentMode::SingleUser, false, false), "{path}");
        }
    }

    #[tokio::test]
    async fn multi_tenant_app_execution_returns_503_before_any_handler_runs() {
        use tower::ServiceExt;
        for route in HOST_ROUTES.iter().filter(|route| route.class == AppSession && route.execution) {
            let router = axum::Router::new().route(route.path, axum::routing::any(|| async { "handler reached" }))
                .layer(axum::middleware::from_fn_with_state(DeploymentMode::MultiTenant, boundary));
            let uri = route.path.replace("{app_slug}", "app").replace("{job_id}", "job").replace("{request_id}", "request");
            let response = router.oneshot(axum::http::Request::builder().method("POST").uri(uri).body(axum::body::Body::empty()).unwrap()).await.unwrap();
            assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE, "{}", route.path);
            let body = axum::body::to_bytes(response.into_body(), 4096).await.unwrap();
            let problem: serde_json::Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(problem["code"], "execution_isolation_unavailable");
        }
        let router = axum::Router::new().route("/api/apps/{app_slug}/runs/{run_id}", axum::routing::get(|| async { "read reached" }))
            .layer(axum::middleware::from_fn_with_state(DeploymentMode::MultiTenant, boundary));
        let response = router.oneshot(axum::http::Request::builder().uri("/api/apps/app/runs/run").body(axum::body::Body::empty()).unwrap()).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[test]
    fn p6c_person_brain_skips_route_admission_only_on_its_two_sockets() {
        let principal = |scope: &str| DeviceContext { device_id: "brain-pb".into(), tenant_id: "pb".into(),
            scope: scope.into(), granted_scopes: vec![], authorization_capabilities: None };
        for path in ["/internal/bridge", "/internal/events"] {
            assert!(person_socket_exempt(path, Some(&principal("person-brain"))), "{path}");
            assert!(!person_socket_exempt(path, Some(&principal("service"))), "{path}");
            assert!(!person_socket_exempt(path, Some(&principal("device"))), "{path}");
            assert!(!person_socket_exempt(path, None), "{path}");
        }
        for path in ["/internal/_rpc/{name}", "/internal/persons", "/internal/org-credentials/{operation}", "/internal/catalog"] {
            assert!(!person_socket_exempt(path, Some(&principal("person-brain"))), "{path}");
        }
    }

    #[tokio::test]
    async fn unclassified_runtime_routes_fail_closed_only_in_multi_tenant() {
        use tower::ServiceExt;
        for mode in [DeploymentMode::SingleUser, DeploymentMode::MultiTenant] {
            let router = axum::Router::new().route("/unclassified", axum::routing::get(|| async { "reachable" }))
                .layer(axum::middleware::from_fn_with_state(mode, boundary));
            let response = router.oneshot(axum::http::Request::builder().uri("/unclassified").body(axum::body::Body::empty()).unwrap()).await.unwrap();
            assert_eq!(response.status(), if mode == DeploymentMode::MultiTenant { StatusCode::FORBIDDEN } else { StatusCode::OK });
        }
    }
}
