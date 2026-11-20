//! 앱 command의 단축키. 기본값은 기획서 4.10이고 전역 설정의 `[shortcuts]`로 바꾼다.

/// app menu가 쓰는 키. command에 줄 수 없다.
pub const MENU_KEYS: [&str; 11] = [
    "Cmd+Q",
    "Cmd+H",
    "Opt+Cmd+H",
    "Cmd+M",
    "Cmd+C",
    "Cmd+V",
    "Cmd+X",
    "Cmd+A",
    "Cmd+Z",
    "Shift+Cmd+Z",
    "Ctrl+Cmd+F",
];

/// 단축키를 둘 수 있는 command.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Command {
    Run,
    RunFile,
    Explain,
    Cancel,
    Save,
    NewTab,
    CloseTab,
    NextTab,
    PrevTab,
    Commit,
    Rollback,
    Reformat,
    OpenProject,
}

impl Command {
    pub const ALL: [Command; 13] = [
        Command::Run,
        Command::RunFile,
        Command::Explain,
        Command::Cancel,
        Command::Save,
        Command::NewTab,
        Command::CloseTab,
        Command::NextTab,
        Command::PrevTab,
        Command::Commit,
        Command::Rollback,
        Command::Reformat,
        Command::OpenProject,
    ];

    /// 설정 파일의 key(`new_tab`)
    pub fn config_key(self) -> &'static str {
        self.names().0
    }

    /// 화면의 CommandId(`newTab`)
    pub fn id(self) -> &'static str {
        self.names().1
    }

    pub fn from_config_key(key: &str) -> Option<Command> {
        Command::ALL
            .into_iter()
            .find(|command| command.config_key() == key)
    }

    fn names(self) -> (&'static str, &'static str) {
        match self {
            Command::Run => ("run", "run"),
            Command::RunFile => ("run_file", "runFile"),
            Command::Explain => ("explain", "explain"),
            Command::Cancel => ("cancel", "cancel"),
            Command::Save => ("save", "save"),
            Command::NewTab => ("new_tab", "newTab"),
            Command::CloseTab => ("close_tab", "closeTab"),
            Command::NextTab => ("next_tab", "nextTab"),
            Command::PrevTab => ("prev_tab", "prevTab"),
            Command::Commit => ("commit", "commit"),
            Command::Rollback => ("rollback", "rollback"),
            Command::Reformat => ("reformat", "reformat"),
            Command::OpenProject => ("open_project", "openProject"),
        }
    }
}

/// key 하나와 modifier. 같은 key인지는 `code`와 modifier로 본다. Cmd는 늘 있으므로(`parse`가 막는다)
/// 따로 두지 않는다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Shortcut {
    /// KeyboardEvent.code(`KeyL`, `Digit1`, `F2`, `Enter`, `BracketLeft`, `Comma` …)
    pub code: String,
    pub shift: bool,
    pub opt: bool,
    pub ctrl: bool,
}

/// 글자 하나로 쓰는 key와 그 code.
const PUNCTUATION: [(&str, &str); 11] = [
    ("[", "BracketLeft"),
    ("]", "BracketRight"),
    (",", "Comma"),
    (".", "Period"),
    ("/", "Slash"),
    (";", "Semicolon"),
    ("'", "Quote"),
    ("-", "Minus"),
    ("=", "Equal"),
    ("`", "Backquote"),
    ("\\", "Backslash"),
];

const KEY_HINT: &str = "use A-Z, 0-9, F1-F12, Enter, or one of [ ] , . / ; ' - = ` \\";

/// 설정 파일의 key 이름을 KeyboardEvent.code로. 글자와 F키, Enter는 대소문자를 가리지 않는다.
fn code_of(key: &str) -> Option<String> {
    let upper = key.to_ascii_uppercase();
    let mut chars = upper.chars();
    if let (Some(c), None) = (chars.next(), chars.next()) {
        if c.is_ascii_uppercase() {
            return Some(format!("Key{c}"));
        }
        if c.is_ascii_digit() {
            return Some(format!("Digit{c}"));
        }
    }
    if upper == "ENTER" {
        return Some("Enter".into());
    }
    if let Some(n) = upper.strip_prefix('F')
        && (1..=12u8).any(|i| i.to_string() == n)
    {
        return Some(upper);
    }
    PUNCTUATION
        .iter()
        .find(|(name, _)| *name == key)
        .map(|(_, code)| (*code).to_string())
}

/// code를 설정 파일의 key 이름으로. `code_of`의 반대다.
fn key_of(code: &str) -> &str {
    if let Some(name) = PUNCTUATION
        .iter()
        .find(|(_, punctuation)| *punctuation == code)
        .map(|(name, _)| *name)
    {
        return name;
    }
    code.strip_prefix("Key")
        .or_else(|| code.strip_prefix("Digit"))
        .unwrap_or(code)
}

impl Shortcut {
    /// `"Opt+Shift+Cmd+Enter"`. 틀리면 이유
    pub fn parse(text: &str) -> Result<Shortcut, String> {
        let parts: Vec<&str> = text.split('+').map(str::trim).collect();
        let (key, modifiers) = parts.split_last().expect("split은 하나 이상을 돌려준다");
        let mut shortcut = Shortcut {
            code: String::new(),
            shift: false,
            opt: false,
            ctrl: false,
        };
        let mut cmd = false;
        for modifier in modifiers {
            let (flag, name) = match modifier.to_ascii_lowercase().as_str() {
                "cmd" => (&mut cmd, "Cmd"),
                "shift" => (&mut shortcut.shift, "Shift"),
                "opt" => (&mut shortcut.opt, "Opt"),
                "ctrl" => (&mut shortcut.ctrl, "Ctrl"),
                _ if code_of(modifier).is_some() => {
                    return Err(format!("only one key is allowed, got \"{text}\""));
                }
                _ => {
                    return Err(format!(
                        "unknown modifier \"{modifier}\"; use Ctrl, Opt, Shift, Cmd"
                    ));
                }
            };
            if *flag {
                return Err(format!("{name} appears twice in \"{text}\""));
            }
            *flag = true;
        }
        if key.is_empty() {
            return Err(format!("missing a key after the modifiers, got \"{text}\""));
        }
        shortcut.code = code_of(key).ok_or_else(|| format!("unknown key \"{key}\"; {KEY_HINT}"))?;
        if !cmd {
            return Err(format!("must include Cmd, got \"{text}\""));
        }
        Ok(shortcut)
    }

    /// 오류 문구용 표기. `Opt+Shift+Cmd+Enter`처럼 Ctrl, Opt, Shift, Cmd 순
    pub fn label(&self) -> String {
        let modifiers = [
            (self.ctrl, "Ctrl+"),
            (self.opt, "Opt+"),
            (self.shift, "Shift+"),
        ];
        let mut label: String = modifiers
            .iter()
            .filter(|(on, _)| *on)
            .map(|(_, name)| *name)
            .collect();
        label.push_str("Cmd+");
        label.push_str(key_of(&self.code));
        label
    }

    /// 같은 키인가. Cmd는 늘 있으므로 code와 나머지 modifier로 본다.
    fn same_keys(&self, other: &Shortcut) -> bool {
        (&self.code, self.shift, self.opt, self.ctrl)
            == (&other.code, other.shift, other.opt, other.ctrl)
    }
}

/// 기획서 4.10의 기본값. run_file, explain은 없다
pub fn default_keymap() -> Vec<(Command, Shortcut)> {
    [
        (Command::Run, "Cmd+Enter"),
        (Command::Cancel, "Cmd+F2"),
        (Command::Save, "Cmd+S"),
        (Command::NewTab, "Shift+Cmd+L"),
        (Command::CloseTab, "Cmd+W"),
        (Command::NextTab, "Shift+Cmd+]"),
        (Command::PrevTab, "Shift+Cmd+["),
        (Command::Commit, "Opt+Shift+Cmd+Enter"),
        (Command::Rollback, "Opt+Shift+Cmd+Z"),
        (Command::Reformat, "Opt+Cmd+L"),
        (Command::OpenProject, "Cmd+O"),
    ]
    .into_iter()
    .map(|(command, text)| (command, Shortcut::parse(text).expect("기본 단축키")))
    .collect()
}

/// 기본값에 덮고 충돌과 menu 키를 검사한다
pub fn merge_keymap(
    overrides: Vec<(Command, Shortcut)>,
) -> Result<Vec<(Command, Shortcut)>, String> {
    let defaults = default_keymap();
    let find = |list: &[(Command, Shortcut)], command: Command| {
        list.iter()
            .find(|(c, _)| *c == command)
            .map(|(_, s)| s.clone())
    };
    let merged: Vec<(Command, Shortcut)> = Command::ALL
        .into_iter()
        .filter_map(|command| {
            find(&overrides, command)
                .or_else(|| find(&defaults, command))
                .map(|shortcut| (command, shortcut))
        })
        .collect();
    // 기본값끼리는 겹치지 않으므로 바꾼 command만 본다.
    for (command, shortcut) in &overrides {
        let key = command.config_key();
        let label = shortcut.label();
        let is_menu_key = MENU_KEYS
            .iter()
            .any(|menu| Shortcut::parse(menu).is_ok_and(|menu| menu.same_keys(shortcut)));
        if is_menu_key {
            return Err(format!("shortcuts.{key}: {label} is an app menu key"));
        }
        if let Some((other, _)) = merged
            .iter()
            .find(|(other, s)| other != command && s.same_keys(shortcut))
        {
            return Err(format!(
                "shortcuts.{key}: {label} is also the shortcut of shortcuts.{}",
                other.config_key()
            ));
        }
    }
    Ok(merged)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> Shortcut {
        Shortcut::parse(text).unwrap_or_else(|e| panic!("{text}: {e}"))
    }

    fn shortcut(code: &str, shift: bool, opt: bool, ctrl: bool) -> Shortcut {
        Shortcut {
            code: code.into(),
            shift,
            opt,
            ctrl,
        }
    }

    #[test]
    fn parses_modifiers_in_any_order_and_case() {
        assert_eq!(parse("cmd+shift+l"), parse("Shift+Cmd+L"));
        assert_eq!(parse("Shift+Cmd+L"), shortcut("KeyL", true, false, false));
        assert_eq!(
            parse("CMD+ctrl+OPT+Shift+enter"),
            shortcut("Enter", true, true, true)
        );
        assert_eq!(parse("Cmd+f2"), shortcut("F2", false, false, false));
    }

    #[test]
    fn key_names_map_to_codes() {
        let cases = [
            ("1", "Digit1"),
            ("0", "Digit0"),
            ("F1", "F1"),
            ("F12", "F12"),
            ("Enter", "Enter"),
            ("[", "BracketLeft"),
            ("]", "BracketRight"),
            (",", "Comma"),
            (".", "Period"),
            ("/", "Slash"),
            (";", "Semicolon"),
            ("'", "Quote"),
            ("-", "Minus"),
            ("=", "Equal"),
            ("`", "Backquote"),
            ("\\", "Backslash"),
            ("A", "KeyA"),
            ("z", "KeyZ"),
        ];
        for (key, code) in cases {
            assert_eq!(parse(&format!("Cmd+{key}")).code, code, "{key}");
        }
    }

    #[test]
    fn requires_cmd() {
        assert_eq!(
            Shortcut::parse("Shift+L"),
            Err("must include Cmd, got \"Shift+L\"".into())
        );
        assert_eq!(
            Shortcut::parse("Enter"),
            Err("must include Cmd, got \"Enter\"".into())
        );
    }

    #[test]
    fn rejects_unknown_keys_and_two_keys() {
        assert_eq!(
            Shortcut::parse("Cmd+Up"),
            Err(
                "unknown key \"Up\"; use A-Z, 0-9, F1-F12, Enter, or one of [ ] , . / ; ' - = ` \\"
                    .into()
            )
        );
        assert_eq!(
            Shortcut::parse("Cmd+L+K"),
            Err("only one key is allowed, got \"Cmd+L+K\"".into())
        );
        assert_eq!(
            Shortcut::parse("Cmd+"),
            Err("missing a key after the modifiers, got \"Cmd+\"".into())
        );
        assert_eq!(
            Shortcut::parse("Cmd+Cmd+L"),
            Err("Cmd appears twice in \"Cmd+Cmd+L\"".into())
        );
        assert_eq!(
            Shortcut::parse("Cmd+F13"),
            Err(
                "unknown key \"F13\"; use A-Z, 0-9, F1-F12, Enter, or one of [ ] , . / ; ' - = ` \\"
                    .into()
            )
        );
        assert!(Shortcut::parse("Hyper+Cmd+L").is_err());
        assert!(Shortcut::parse("").is_err());
    }

    #[test]
    fn defaults_match_the_spec() {
        let defaults: Vec<(Command, String)> = default_keymap()
            .into_iter()
            .map(|(command, shortcut)| (command, shortcut.label()))
            .collect();
        let expected: Vec<(Command, String)> = [
            (Command::Run, "Cmd+Enter"),
            (Command::Cancel, "Cmd+F2"),
            (Command::Save, "Cmd+S"),
            (Command::NewTab, "Shift+Cmd+L"),
            (Command::CloseTab, "Cmd+W"),
            (Command::NextTab, "Shift+Cmd+]"),
            (Command::PrevTab, "Shift+Cmd+["),
            (Command::Commit, "Opt+Shift+Cmd+Enter"),
            (Command::Rollback, "Opt+Shift+Cmd+Z"),
            (Command::Reformat, "Opt+Cmd+L"),
            (Command::OpenProject, "Cmd+O"),
        ]
        .into_iter()
        .map(|(command, label)| (command, label.to_string()))
        .collect();
        assert_eq!(defaults, expected);
        assert_eq!(merge_keymap(Vec::new()), Ok(default_keymap()));
    }

    #[test]
    fn label_round_trips() {
        let labels = [
            "Cmd+Enter",
            "Ctrl+Opt+Shift+Cmd+F12",
            "Ctrl+Cmd+1",
            "Opt+Cmd+\\",
            "Shift+Cmd+`",
            "Cmd+'",
            "Cmd+,",
        ];
        for label in labels {
            assert_eq!(parse(label).label(), label);
        }
        for (_, shortcut) in default_keymap() {
            assert_eq!(parse(&shortcut.label()), shortcut);
        }
    }

    #[test]
    fn command_keys_and_ids() {
        let keys: Vec<(&str, &str)> = Command::ALL
            .iter()
            .map(|command| (command.config_key(), command.id()))
            .collect();
        assert_eq!(
            keys,
            [
                ("run", "run"),
                ("run_file", "runFile"),
                ("explain", "explain"),
                ("cancel", "cancel"),
                ("save", "save"),
                ("new_tab", "newTab"),
                ("close_tab", "closeTab"),
                ("next_tab", "nextTab"),
                ("prev_tab", "prevTab"),
                ("commit", "commit"),
                ("rollback", "rollback"),
                ("reformat", "reformat"),
                ("open_project", "openProject"),
            ]
        );
        for command in Command::ALL {
            assert_eq!(
                Command::from_config_key(command.config_key()),
                Some(command)
            );
        }
        assert_eq!(Command::from_config_key("newTab"), None);
    }

    #[test]
    fn merge_overrides_and_adds_in_command_order() {
        let merged = merge_keymap(vec![
            (Command::Explain, parse("Shift+Cmd+E")),
            (Command::Reformat, parse("Shift+Cmd+F")),
        ])
        .unwrap();
        let reformat = merged.iter().find(|(c, _)| *c == Command::Reformat);
        assert_eq!(reformat.unwrap().1.label(), "Shift+Cmd+F");
        let order: Vec<Command> = merged.iter().map(|(c, _)| *c).collect();
        assert_eq!(order[0], Command::Run);
        assert_eq!(order[1], Command::Explain);
        assert_eq!(merged.len(), 12);
    }

    #[test]
    fn merge_rejects_conflicts_and_menu_keys() {
        assert_eq!(
            merge_keymap(vec![(Command::Save, parse("Cmd+Enter"))]),
            Err("shortcuts.save: Cmd+Enter is also the shortcut of shortcuts.run".into())
        );
        // 기본값의 키를 비우면 다른 command가 쓸 수 있다.
        assert!(
            merge_keymap(vec![
                (Command::Save, parse("Cmd+Enter")),
                (Command::Run, parse("Shift+Cmd+R")),
            ])
            .is_ok()
        );
        // modifier가 하나라도 다르면 다른 키다.
        assert!(merge_keymap(vec![(Command::Save, parse("Ctrl+Cmd+Enter"))]).is_ok());
        assert_eq!(
            merge_keymap(vec![(Command::Run, parse("Cmd+Q"))]),
            Err("shortcuts.run: Cmd+Q is an app menu key".into())
        );
        for menu in MENU_KEYS {
            let shortcut = parse(menu);
            assert!(
                merge_keymap(vec![(Command::Explain, shortcut)]).is_err(),
                "{menu}"
            );
        }
    }
}
