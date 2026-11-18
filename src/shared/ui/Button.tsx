import type { ComponentProps } from "react";

type Variant = "primary" | "secondary" | "ghost";

const VARIANT: Record<Variant, string> = {
  primary:
    "border-accent bg-accent font-semibold text-bg-0 [&_kbd]:bg-bg-0/20 [&_kbd]:text-bg-0",
  secondary: "border-line-2 bg-bg-2 text-fg",
  ghost: "border-transparent bg-transparent text-fg-2",
};

/** small은 표 안의 줄처럼 좁은 자리에 쓴다(캔버스 States 7의 "Run again"). */
const SIZE = { regular: "h-7 text-body", small: "h-6 text-small" } as const;

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
      className={`rounded-control focus-visible:outline-accent inline-flex shrink-0 cursor-pointer items-center gap-2 border px-3 whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-1 disabled:cursor-default disabled:opacity-50 ${SIZE[size]} ${VARIANT[variant]} ${className}`}
      {...rest}
    />
  );
}
