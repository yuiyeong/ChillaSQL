/**
 * 접속 정보, 경로처럼 쓴 그대로 남아야 하는 입력란에 펼친다.
 * macOS WebKit은 기본으로 자동 수정과 자동 대문자를 켠다.
 */
export const noTextCorrection = {
  autoCorrect: "off",
  autoCapitalize: "off",
  spellCheck: false,
} as const;
