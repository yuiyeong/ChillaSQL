//! [`ShellTunnelRunner::is_open`]. 프로세스를 띄우는 test와 같은 binary에 두면 fork된 자식이
//! exec 전까지 listener를 쥐고 있어 닫은 포트가 잠깐 열려 보인다. 그래서 따로 둔다.

use chilla_core::application::TunnelRunner;
use chilla_core::infrastructure::ShellTunnelRunner;
use tokio::net::TcpListener;

#[tokio::test]
async fn is_open_follows_a_listener() {
    let runner = ShellTunnelRunner::with_shell("/bin/zsh".into());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    assert!(runner.is_open("127.0.0.1", port).await);
    drop(listener);
    assert!(!runner.is_open("127.0.0.1", port).await);
}
