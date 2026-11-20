import { useEffect, useState } from "react";
import { homeDir } from "../../shared/api/path";
import { t, type Language } from "../../shared/i18n/t";
import { projectInitials, shortenHome } from "./fileTree";

/** "chilla-demo" -> "CD", "billing" -> "BI", "billing-migration" -> "BM" */
export const initials = projectInitials;

/** home 아래면 "~/…"로 줄인다. */
export function shortPath(dir: string, home: string): string {
  return shortenHome(dir, home);
}

const MINUTE = 60_000;

/** 지역 시각의 그 날 0시 */
function startOfDay(time: number): number {
  const date = new Date(time);
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  ).getTime();
}

/**
 * 프로젝트를 연 때를 한 마디로. 1분 안이면 Just now, 오늘이면 Today, 어제면 Yesterday, 그 밖에는
 * `language`에 맞는 짧은 날짜(Nov 9, 11월 9일)다. `openedAt`과 `now`는 둘 다 밀리초다(Rust가 주는
 * Unix 초는 1000을 곱해 넘긴다). 오늘과 어제는 지역 시각의 날짜로 가른다. 낱말은 `t`가 고른 언어다.
 */
export function openedWhen(
  openedAt: number,
  now: number,
  language: Language,
): string {
  if (now - openedAt < MINUTE) return t("when.justNow");
  const today = startOfDay(now);
  if (openedAt >= today) return t("when.today");
  // 하루는 24시간이 아닐 수 있으므로(일광 절약 시간) 어제 0시는 날짜로 구한다.
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (openedAt >= yesterday.getTime()) return t("when.yesterday");
  return new Intl.DateTimeFormat(language, {
    month: "short",
    day: "numeric",
  }).format(openedAt);
}

/**
 * 사용자의 home 디렉토리. 경로를 `~`로 줄이는 데 쓴다. 아직 모르거나 알 수 없으면 null이라 전체
 * 경로를 그대로 보여 준다.
 */
export function useHome(): string | null {
  const [home, setHome] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const dir = await homeDir();
        if (live) setHome(dir);
      } catch {
        // home을 모르면 전체 경로를 그대로 보여 준다.
      }
    })();
    return () => {
      live = false;
    };
  }, []);
  return home;
}
