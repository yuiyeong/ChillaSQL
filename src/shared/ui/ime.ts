/**
 * 한글 조합 중의 key인지. 조합 중의 Enter는 조합을 끝낼 뿐이다. WKWebView는 조합을 끝내는 Enter에
 * isComposing을 false로 보내므로 keyCode 229도 본다.
 */
export function isImeComposing(
  event: Pick<KeyboardEvent, "isComposing" | "keyCode">,
): boolean {
  return event.isComposing || event.keyCode === 229;
}
