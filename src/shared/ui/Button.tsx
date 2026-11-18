import type { ComponentProps } from "react";

type Variant = "primary" | "secondary" | "ghost" | "dashed";

const VARIANT: Record<Variant, string> = {
  primary:
    "border-accent bg-accent font-semibold text-bg-0 [&_kbd]:bg-bg-0/20 [&_kbd]:text-bg-0",
  secondary: "border-line-2 bg-bg-2 text-fg",
  ghost: "border-transparent bg-transparent text-fg-2",
  /** 아직 고르지 않은 것(접속이 없는 탭의 접속 chip) */
  dashed: "border-line-2 border-dashed bg-transparent text-fg",
};

/**
 * 높이와 좌우 padding. small은 표 안의 줄처럼 좁은 자리에 쓴다(캔버스 States 7의 "Run again").
 * chip은 toolbar의 접속 chip, kbd는 끝에 단축키가 붙는 버튼, icon은 padding 없이 icon만 가운데 둔다.
 */
const SIZE = {
  regular: "h-7 px-3 text-body",
  small: "h-6 px-3 text-small",
  chip: "h-7 px-2.5 text-body",
  kbd: "h-7 pr-2 pl-3 text-body",
  icon: "h-7 justify-center text-body",
} as const;

interface Props extends ComponentProps<"button"> {
  variant?: Variant;
  size?: keyof typeof SIZE;
}

/** 높이 28px(small은 24px)의 control. primary는 화면에 하나(실행)만 쓴다. */
export function Button({
  variant = "secondary",
  size = "regular",
  type = "button",
  className = "",
  ...rest
}: Props) {
  return (
    <button
      type={type}
      className={[
        "rounded-control focus-visible:outline-accent inline-flex shrink-0 cursor-pointer items-center gap-2 border whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-1 disabled:cursor-default disabled:opacity-50",
        SIZE[size],
        VARIANT[variant],
        className,
      ].join(" ")}
      {...rest}
    />
  );
}
