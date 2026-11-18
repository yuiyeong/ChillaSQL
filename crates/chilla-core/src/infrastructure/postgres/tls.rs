//! PostgreSQL의 SSL 협상과 TLS handshake.
//!
//! `tokio-postgres`에 맡기지 않고 직접 한다. [`TxTap`](super::tx_tap::TxTap)이 복호화된 byte를
//! 봐야 하기 때문이다.

use std::io;
use std::path::Path;
use std::sync::Arc;

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{CryptoProvider, verify_tls12_signature, verify_tls13_signature};
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, RootCertStore, SignatureScheme};
use rustls_platform_verifier::BuilderVerifierExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;
use tokio_rustls::client::TlsStream;

use crate::application::ConnectError;

/// SSLRequest: 길이 8, code 80877103.
const SSL_REQUEST: [u8; 8] = [0, 0, 0, 8, 0x04, 0xD2, 0x16, 0x2F];

/// 서버 인증서를 어떻게 확인할지.
pub(crate) enum Verification<'a> {
    /// `sslmode = "require"`: 암호화만 하고 인증서는 확인하지 않는다.
    None,
    /// `verify-full` + `sslrootcert`: 이 PEM 파일의 인증서만 신뢰한다.
    RootsFrom(&'a Path),
    /// `verify-full`: macOS의 trust store로 확인한다.
    Platform,
}

pub(crate) async fn negotiate(
    mut tcp: TcpStream,
    host: &str,
    verification: Verification<'_>,
) -> Result<TlsStream<TcpStream>, ConnectError> {
    // 설정의 잘못(읽을 수 없는 sslrootcert 등)은 서버와 말하기 전에 알린다.
    let config = client_config(verification)?;
    let server_name = ServerName::try_from(host.to_string()).map_err(|_| ConnectError::Other {
        message: format!("host '{host}' cannot be used for an SSL connection"),
    })?;

    tcp.write_all(&SSL_REQUEST).await.map_err(io_error)?;
    // 답은 1 byte다. 더 읽으면 handshake의 첫 byte를 삼킨다.
    let mut answer = [0u8; 1];
    tcp.read_exact(&mut answer).await.map_err(io_error)?;
    match answer[0] {
        b'S' => {}
        b'N' => return Err(ConnectError::TlsNotSupported),
        other => {
            return Err(ConnectError::Other {
                message: format!(
                    "The server sent an unknown reply ({other:#04x}) to the SSL request"
                ),
            });
        }
    }

    TlsConnector::from(Arc::new(config))
        .connect(server_name, tcp)
        .await
        .map_err(handshake_error)
}

fn client_config(verification: Verification<'_>) -> Result<ClientConfig, ConnectError> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let builder = ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(tls_setup_error)?;
    let builder = match verification {
        Verification::None => builder
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(NoVerification(provider))),
        Verification::RootsFrom(path) => builder.with_root_certificates(load_roots(path)?),
        Verification::Platform => builder.with_platform_verifier().map_err(tls_setup_error)?,
    };
    Ok(builder.with_no_client_auth())
}

fn load_roots(path: &Path) -> Result<RootCertStore, ConnectError> {
    let unreadable = |reason: String| ConnectError::Certificate {
        message: format!("sslrootcert {}: {reason}", path.display()),
    };
    let mut roots = RootCertStore::empty();
    let certs = CertificateDer::pem_file_iter(path).map_err(|e| unreadable(e.to_string()))?;
    for cert in certs {
        let cert = cert.map_err(|e| unreadable(e.to_string()))?;
        roots.add(cert).map_err(|e| unreadable(e.to_string()))?;
    }
    if roots.is_empty() {
        return Err(unreadable("No PEM certificate found".into()));
    }
    Ok(roots)
}

/// `sslmode = "require"`의 verifier. 인증서와 host 이름은 보지 않고, handshake signature만
/// 확인한다 (서버가 내민 인증서의 key를 실제로 갖고 있는지).
#[derive(Debug)]
struct NoVerification(Arc<CryptoProvider>);

impl ServerCertVerifier for NoVerification {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

fn handshake_error(error: io::Error) -> ConnectError {
    let certificate_rejected = error
        .get_ref()
        .and_then(|inner| inner.downcast_ref::<rustls::Error>())
        .is_some_and(|e| matches!(e, rustls::Error::InvalidCertificate(_)));
    let message = error.to_string();
    if certificate_rejected {
        ConnectError::Certificate { message }
    } else {
        ConnectError::Other { message }
    }
}

fn tls_setup_error(error: rustls::Error) -> ConnectError {
    ConnectError::Other {
        message: format!("SSL setup failed: {error}"),
    }
}

fn io_error(error: io::Error) -> ConnectError {
    ConnectError::Other {
        message: error.to_string(),
    }
}
