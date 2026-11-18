import type { ButtonHTMLAttributes } from "react";

interface Props extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "aria-label"
> {
  /** 화면에 글자가 없으므로 `aria-label`로 쓴다. */
  label: string;
  size?: 22 | 28;
}

const SIZE = { 22: "size-[22px]", 28: "size-7" } as const;

/** icon만 있는 정사각 button. */
export function IconButton({
  label,
  size = 28,
  type = "button",
  className = "",
  ...rest
}: Props) {
  return (
    <button
      type={type}
      aria-label={label}
      className={`text-fg-2 hover:bg-bg-3 hover:text-fg focus-visible:outline-accent inline-flex shrink-0 cursor-pointer items-center justify-center rounded-[6px] border-0 bg-transparent focus-visible:outline-2 disabled:cursor-default disabled:opacity-50 ${SIZE[size]} ${className}`}
      {...rest}
    />
  );
}
