use chrono::{DateTime, Duration, Utc};
use rcgen::{
    CertificateSigningRequestParams, DistinguishedName, DnType, ExtendedKeyUsagePurpose, KeyPair,
    KeyUsagePurpose, SanType,
};
use sha2::{Digest, Sha256};
use std::sync::Arc;

#[derive(Clone, Debug)]
pub struct IssuedCertificate {
    pub certificate_pem: String,
    pub ca_certificate_pem: String,
    pub fingerprint_sha256: String,
    pub expires_at: DateTime<Utc>,
}

pub trait CertificateIssuer: Send + Sync {
    fn issue(
        &self,
        agent_id: &str,
        target_id: &str,
        csr_pem: &str,
    ) -> anyhow::Result<IssuedCertificate>;
}

pub struct RcgenCertificateIssuer {
    ca_certificate_pem: String,
    ca_issuer: rcgen::Issuer<'static, KeyPair>,
    validity: Duration,
}

impl RcgenCertificateIssuer {
    pub fn from_pem(
        ca_certificate_pem: String,
        ca_private_key_pem: &str,
        validity: Duration,
    ) -> anyhow::Result<Arc<Self>> {
        let ca_key = KeyPair::from_pem(ca_private_key_pem)?;
        let ca_issuer = rcgen::Issuer::from_ca_cert_pem(&ca_certificate_pem, ca_key)?;
        Ok(Arc::new(Self {
            ca_certificate_pem,
            ca_issuer,
            validity,
        }))
    }
}

impl CertificateIssuer for RcgenCertificateIssuer {
    fn issue(
        &self,
        agent_id: &str,
        target_id: &str,
        csr_pem: &str,
    ) -> anyhow::Result<IssuedCertificate> {
        validate_identity_component(agent_id)?;
        validate_identity_component(target_id)?;
        let mut csr = CertificateSigningRequestParams::from_pem(csr_pem)?;
        let common_name = format!("{agent_id}.{target_id}.agent.cognia.internal");
        let mut distinguished_name = DistinguishedName::new();
        distinguished_name.push(DnType::CommonName, common_name.clone());
        csr.params.distinguished_name = distinguished_name;
        csr.params.subject_alt_names = vec![SanType::DnsName(common_name.try_into()?)];
        csr.params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ClientAuth];
        csr.params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
        let now = Utc::now();
        let expires_at = now + self.validity;
        csr.params.not_before =
            time::OffsetDateTime::from_unix_timestamp((now - Duration::minutes(5)).timestamp())?;
        csr.params.not_after = time::OffsetDateTime::from_unix_timestamp(expires_at.timestamp())?;
        let certificate = csr.signed_by(&self.ca_issuer)?;
        let fingerprint_sha256 = hex::encode(Sha256::digest(certificate.der().as_ref()));
        Ok(IssuedCertificate {
            certificate_pem: certificate.pem(),
            ca_certificate_pem: self.ca_certificate_pem.clone(),
            fingerprint_sha256,
            expires_at,
        })
    }
}

fn validate_identity_component(value: &str) -> anyhow::Result<()> {
    if value.is_empty()
        || value.len() > 63
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        anyhow::bail!("agent and target identifiers must be DNS-safe");
    }
    Ok(())
}
