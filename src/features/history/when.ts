import { dayWord } from "../project/recent";
import { useSettings } from "../settings/settingsStore";

/** 기록의 날짜 묶음 label. Today, Yesterday, 그 밖에는 Nov 9(설정의 언어)다. */
export function dayLabel(at: number, now: number): string {
  return dayWord(at, now, useSettings.getState().language);
}

/** 지역 시각의 24시간제 시각. `09:41` */
export function timeOfDay(at: number): string {
  const date = new Date(at);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(date.getHours())}:${two(date.getMinutes())}`;
}
