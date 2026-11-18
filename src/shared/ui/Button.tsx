import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "ghost";

const VARIANT: Record<Variant, string> = {
  primary:
    "border-accent bg-accent font-semibold text-bg-0 [&_kbd]:bg-bg-0/20 [&_kbd]:text-bg-0",
  secondary: "border-line-2 bg-bg-2 text-fg",
  ghost: "border-transparent bg-transparent text-fg-2",
};

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
}

/** 높이 28px의 control. primary는 화면에 하나(실행)만 쓴다. */
export function Button({
  variant = "secondary",
  type = "button",
  className = "",
  ...rest
}: Props) {
  return (
    <button
      type={type}
      className={`rounded-control text-body focus-visible:outline-accent inline-flex h-7 shrink-0 cursor-pointer items-center gap-2 border px-3 whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-1 disabled:cursor-default disabled:opacity-50 ${VARIANT[variant]} ${className}`}
      {...rest}
    />
  );
}
