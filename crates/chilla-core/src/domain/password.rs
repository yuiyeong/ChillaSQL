use std::fmt;

/// 접속 비밀번호. 화면이나 로그로 새지 않도록 `Serialize`, `Display`, `Clone`을 구현하지 않는다.
pub struct Password(String);

impl Password {
    pub fn new(value: String) -> Self {
        Self(value)
    }

    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Password {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Password(***)")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn password_debug_hides_the_value() {
        assert_eq!(
            format!("{:?}", Password::new("hunter2".into())),
            "Password(***)"
        );
    }

    #[test]
    fn expose_returns_the_value() {
        assert_eq!(Password::new("hunter2".into()).expose(), "hunter2");
    }
}
