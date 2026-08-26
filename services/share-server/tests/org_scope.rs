//! The org-scoped plane — ADR-0149 §8.
//!
//! Before this, the service had one global bearer for every write and no
//! notion of whose shares these were: a leaked secret was every tenant's
//! secret, and off-boarding somebody meant already holding every per-share
//! token they had ever been given.

mod common;

use reqwest::Client;
use serde_json::{json, Value};

async fn create_with(client: &Client, base: &str, authorization: &str) -> Value {
    let response = client
        .post(format!("{base}/v1/share"))
        .header("authorization", authorization)
        .json(&json!({ "envelope": common::valid_envelope() }))
        .send()
        .await
        .expect("create");
    assert_eq!(response.status(), 201, "create should succeed");
    response.json().await.expect("json")
}

async fn list(client: &Client, base: &str, org_id: &str, authorization: &str) -> reqwest::Response {
    client
        .get(format!("{base}/v1/orgs/{org_id}/shares"))
        .header("authorization", authorization)
        .send()
        .await
        .expect("list")
}

#[tokio::test]
async fn a_share_created_with_a_grant_is_listed_for_its_org() {
    let (base, _dir) = common::start().await;
    let client = Client::new();
    let grant = format!("Bearer {}", common::grant_for("org_acme"));

    let created = create_with(&client, &base, &grant).await;
    let code = created["code"].as_str().expect("code").to_string();

    let listed = list(&client, &base, "org_acme", &grant).await;
    assert_eq!(listed.status(), 200);
    let body: Value = listed.json().await.expect("json");
    let shares = body["shares"].as_array().expect("shares");
    assert_eq!(shares.len(), 1);
    assert_eq!(shares[0]["code"], code);
    assert_eq!(shares[0]["creatorUserId"], "usr_ada");
    // The listing is for deciding what to revoke. Handing back the per-share
    // secret would turn a read into a grant.
    assert!(shares[0].get("ownerToken").is_none());
    assert!(shares[0].get("envelope").is_none());
}

#[tokio::test]
async fn a_share_created_with_the_legacy_secret_belongs_to_no_org() {
    let (base, _dir) = common::start().await;
    let client = Client::new();

    create_with(&client, &base, &format!("Bearer {}", common::SECRET)).await;

    // It still works, and is still readable by code — it simply has no org to
    // be listed under, because the credential proved nothing about who asked.
    let listed = list(
        &client,
        &base,
        "org_acme",
        &format!("Bearer {}", common::grant_for("org_acme")),
    )
    .await;
    assert_eq!(listed.status(), 200);
    let body: Value = listed.json().await.expect("json");
    assert!(body["shares"].as_array().expect("shares").is_empty());
}

#[tokio::test]
async fn one_org_cannot_see_or_delete_another_org_s_shares() {
    let (base, _dir) = common::start().await;
    let client = Client::new();
    let acme = format!("Bearer {}", common::grant_for("org_acme"));
    let other = format!("Bearer {}", common::grant_for("org_other"));

    let created = create_with(&client, &base, &acme).await;
    let code = created["code"].as_str().expect("code");

    // A grant for a different org is refused exactly like no grant at all —
    // a distinguishable "wrong org" would confirm the org in the path exists.
    assert_eq!(list(&client, &base, "org_acme", &other).await.status(), 401);

    let listed = list(&client, &base, "org_other", &other).await;
    assert_eq!(listed.status(), 200);
    let body: Value = listed.json().await.expect("json");
    assert!(body["shares"].as_array().expect("shares").is_empty());

    // And a code in somebody else's org answers like a code that never
    // existed, so the response is not an oracle for which codes are real.
    let deleted = client
        .delete(format!("{base}/v1/orgs/org_other/shares/{code}"))
        .header("authorization", &other)
        .send()
        .await
        .expect("delete");
    assert_eq!(deleted.status(), 404);

    // The share survived.
    let still_there = client
        .get(format!("{base}/v1/share/{code}"))
        .send()
        .await
        .expect("read");
    assert_eq!(still_there.status(), 200);
}

#[tokio::test]
async fn an_org_admin_revokes_a_share_without_its_owner_token() {
    // ADR-0149 §8's motivating case: somebody leaves and their links have to
    // go, and nobody kept the per-share secrets they were handed.
    let (base, _dir) = common::start().await;
    let client = Client::new();
    let grant = format!("Bearer {}", common::grant_for("org_acme"));

    let created = create_with(&client, &base, &grant).await;
    let code = created["code"].as_str().expect("code");

    let deleted = client
        .delete(format!("{base}/v1/orgs/org_acme/shares/{code}"))
        .header("authorization", &grant)
        .send()
        .await
        .expect("delete");
    assert_eq!(deleted.status(), 200);

    let gone = client
        .get(format!("{base}/v1/share/{code}"))
        .send()
        .await
        .expect("read");
    assert_eq!(gone.status(), 404);
}

#[tokio::test]
async fn the_legacy_secret_cannot_reach_the_org_plane_at_all() {
    // One global bearer says nothing about which org is asking. Honouring it
    // here would let any holder list and delete every tenant's links, which is
    // the exact failure ADR-0149 §8 names.
    let (base, _dir) = common::start().await;
    let client = Client::new();

    assert_eq!(
        list(
            &client,
            &base,
            "org_acme",
            &format!("Bearer {}", common::SECRET)
        )
        .await
        .status(),
        401
    );
    assert_eq!(
        client
            .delete(format!("{base}/v1/orgs/org_acme/shares/abcdefgh"))
            .header("authorization", format!("Bearer {}", common::SECRET))
            .send()
            .await
            .expect("delete")
            .status(),
        401
    );
}

#[tokio::test]
async fn a_deployment_with_no_grant_key_accepts_no_grant() {
    // Absence of a key means "this deployment has no collaboration plane",
    // never "authorize anyone".
    let (base, _dir) = common::start_with(|config| config.grant_key_hex = String::new()).await;
    let client = Client::new();

    assert_eq!(
        list(
            &client,
            &base,
            "org_acme",
            &format!("Bearer {}", common::grant_for("org_acme"))
        )
        .await
        .status(),
        401
    );
}
