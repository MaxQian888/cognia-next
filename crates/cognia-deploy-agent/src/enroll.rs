use chrono::{DateTime, Utc};
use rcgen::{
    CertificateParams, DistinguishedName, DnType, ExtendedKeyUsagePurpose, KeyPair, KeyUsagePurpose,
};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use url::Url;

pub struct EnrollmentOptions {
    pub controller_url: Url,
    pub token: String,
    pub agent_id: String,
    pub output_directory: PathBuf,
    pub controller_ca_file: Option<PathBuf>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EnrollmentRequest {
    token: String,
    agent_id: String,
    csr_pem: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnrollmentResponse {
    target_id: String,
    certificate_pem: String,
    ca_certificate_pem: String,
    certificate_fingerprint: String,
    expires_at: DateTime<Utc>,
    controller_signing_key_id: String,
    controller_signing_key: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EnrollmentBundle {
    api_version: &'static str,
    agent_id: String,
    target_id: String,
    controller_url: Url,
    controller_signing_key_id: String,
    controller_signing_key: String,
    certificate_file: PathBuf,
    private_key_file: PathBuf,
    ca_file: PathBuf,
    certificate_fingerprint: String,
    certificate_expires_at: i64,
}

pub async fn enroll(options: EnrollmentOptions) -> anyhow::Result<PathBuf> {
    validate_agent_id(&options.agent_id)?;
    let key = KeyPair::generate()?;
    let mut params = CertificateParams::new(Vec::<String>::new())?;
    let mut distinguished_name = DistinguishedName::new();
    distinguished_name.push(DnType::CommonName, options.agent_id.clone());
    params.distinguished_name = distinguished_name;
    params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ClientAuth];
    params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
    let csr_pem = params.serialize_request(&key)?.pem()?;

    let mut client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(5))
        .timeout(std::time::Duration::from_secs(30));
    if let Some(ca_file) = &options.controller_ca_file {
        let ca = tokio::fs::read(ca_file).await?;
        client = client.add_root_certificate(reqwest::Certificate::from_pem(&ca)?);
    }
    let client = client.build()?;
    let enrollment_url = options.controller_url.join("/v1/agents/enroll")?;
    let response: EnrollmentResponse = client
        .post(enrollment_url)
        .json(&EnrollmentRequest {
            token: options.token,
            agent_id: options.agent_id.clone(),
            csr_pem,
        })
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;

    tokio::fs::create_dir_all(&options.output_directory).await?;
    let certificate_file = options.output_directory.join("agent.crt.pem");
    let private_key_file = options.output_directory.join("agent.key.pem");
    let ca_file = options.output_directory.join("controller-ca.crt.pem");
    tokio::fs::write(&certificate_file, response.certificate_pem).await?;
    tokio::fs::write(&private_key_file, key.serialize_pem()).await?;
    restrict_private_key(&private_key_file).await?;
    tokio::fs::write(&ca_file, response.ca_certificate_pem).await?;

    let bundle_file = options.output_directory.join("enrollment.json");
    let bundle = EnrollmentBundle {
        api_version: "deploy.cognia.dev/agent-enrollment/v1alpha1",
        agent_id: options.agent_id,
        target_id: response.target_id,
        controller_url: options.controller_url,
        controller_signing_key_id: response.controller_signing_key_id,
        controller_signing_key: response.controller_signing_key,
        certificate_file,
        private_key_file,
        ca_file,
        certificate_fingerprint: response.certificate_fingerprint,
        certificate_expires_at: response.expires_at.timestamp(),
    };
    tokio::fs::write(&bundle_file, serde_json::to_vec_pretty(&bundle)?).await?;
    Ok(bundle_file)
}

async fn restrict_private_key(path: &std::path::Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).await?;
    }
    Ok(())
}

fn validate_agent_id(value: &str) -> anyhow::Result<()> {
    if value.is_empty()
        || value.len() > 63
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        anyhow::bail!("agent id must be DNS-safe");
    }
    Ok(())
}
