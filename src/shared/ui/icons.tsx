import type { SVGProps } from "react";

// 모양은 docs/design/canvas의 SVG를 그대로 옮겼다. 색은 currentColor라 글자 색을 따른다.
// 크기와 선 굵기는 캔버스에서 그 icon을 가장 많이 쓴 값이 기본값이다.

type IconProps = Omit<SVGProps<SVGSVGElement>, "width" | "height"> & {
  size?: number;
};

function Stroke({
  size,
  width,
  join = false,
  children,
  ...rest
}: IconProps & { size: number; width: number; join?: boolean }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={width}
      strokeLinecap="round"
      strokeLinejoin={join ? "round" : undefined}
      {...rest}
    >
      {children}
    </svg>
  );
}

function Solid({ size, children, ...rest }: IconProps & { size: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
      {...rest}
    >
      {children}
    </svg>
  );
}

export function PlayIcon({ size = 12, ...rest }: IconProps) {
  return (
    <Solid size={size} {...rest}>
      <path d="M4 2.8v10.4a.8.8 0 0 0 1.2.7l8.4-5.2a.8.8 0 0 0 0-1.4L5.2 2.1a.8.8 0 0 0-1.2.7z" />
    </Solid>
  );
}

export function StopIcon({ size = 11, ...rest }: IconProps) {
  return (
    <Solid size={size} {...rest}>
      <rect x="3" y="3" width="10" height="10" rx="2" />
    </Solid>
  );
}

export function ChevronDownIcon({ size = 12, ...rest }: IconProps) {
  return (
    <Stroke size={size} width={1.6} join {...rest}>
      <path d="M4 6l4 4 4-4" />
    </Stroke>
  );
}

export function ChevronRightIcon({ size = 12, ...rest }: IconProps) {
  return (
    <Stroke size={size} width={1.6} join {...rest}>
      <path d="M6 4l4 4-4 4" />
    </Stroke>
  );
}

export function PlusIcon({ size = 14, ...rest }: IconProps) {
  return (
    <Stroke size={size} width={1.5} {...rest}>
      <path d="M8 3v10M3 8h10" />
    </Stroke>
  );
}

export function CloseIcon({ size = 10, ...rest }: IconProps) {
  return (
    <Stroke size={size} width={1.8} {...rest}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </Stroke>
  );
}

export function CopyIcon({ size = 14, ...rest }: IconProps) {
  return (
    <Stroke size={size} width={1.5} join {...rest}>
      <rect x="5" y="5" width="8.5" height="8.5" rx="1.5" />
      <path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" />
    </Stroke>
  );
}

export function RefreshIcon({ size = 13, ...rest }: IconProps) {
  return (
    <Stroke size={size} width={1.5} join {...rest}>
      <path d="M13 8a5 5 0 1 1-1.5-3.5M13 2.5V5h-2.5" />
    </Stroke>
  );
}

export function FolderIcon({ size = 14, ...rest }: IconProps) {
  return (
    <Stroke size={size} width={1.4} join {...rest}>
      <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" />
    </Stroke>
  );
}

export function FileIcon({ size = 14, ...rest }: IconProps) {
  return (
    <Stroke size={size} width={1.4} join {...rest}>
      <path d="M4 2h5l3 3v9H4z" />
      <path d="M9 2v3h3" />
    </Stroke>
  );
}

export function TunnelIcon({ size = 12, ...rest }: IconProps) {
  return (
    <Stroke size={size} width={1.5} {...rest}>
      <path d="M2 13V8a6 6 0 0 1 12 0v5M5.5 13V8.5a2.5 2.5 0 0 1 5 0V13" />
    </Stroke>
  );
}

export function CheckIcon({ size = 14, ...rest }: IconProps) {
  return (
    <Stroke size={size} width={1.7} join {...rest}>
      <path d="M3.5 8.2l3 3 6-6.5" />
    </Stroke>
  );
}

export function ErrorIcon({ size = 12, ...rest }: IconProps) {
  return (
    <Stroke size={size} width={1.8} {...rest}>
      <circle cx="8" cy="8" r="6" />
      <path d="M6 6l4 4M10 6l-4 4" />
    </Stroke>
  );
}

export function ExternalTunnelIcon({ size = 12, ...rest }: IconProps) {
  return (
    <Stroke size={size} width={1.5} join {...rest}>
      <path d="M9 3h4v4M13 3L7.5 8.5M11 9.5V13H3V5h3.5" />
    </Stroke>
  );
}

export function ReconnectIcon({ size = 16, ...rest }: IconProps) {
  return (
    <Stroke size={size} width={1.6} join {...rest}>
      <path d="M13 8a5 5 0 1 1-1.5-3.5M13 2.5V5h-2.5" />
    </Stroke>
  );
}

export function LockIcon({ size = 15, ...rest }: IconProps) {
  return (
    <Stroke size={size} width={1.6} {...rest}>
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </Stroke>
  );
}

export function WarningIcon({ size = 14, ...rest }: IconProps) {
  return (
    <Stroke size={size} width={1.6} join {...rest}>
      <path d="M8 2.2L14.5 13.5h-13z" />
      <path d="M8 6.5v3M8 11.6h.01" />
    </Stroke>
  );
}

export function CancelledIcon({ size = 14, ...rest }: IconProps) {
  return (
    <Stroke size={size} width={1.6} {...rest}>
      <circle cx="8" cy="8" r="6" />
      <path d="M5.5 5.5l5 5" />
    </Stroke>
  );
}

export function ClockIcon({ size = 14, ...rest }: IconProps) {
  return (
    <Stroke size={size} width={1.6} {...rest}>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.5V8l2.5 1.5" />
    </Stroke>
  );
}

export function LinkBrokenIcon({ size = 14, ...rest }: IconProps) {
  return (
    <Stroke size={size} width={1.6} {...rest}>
      <path d="M6 10l-1.5 1.5a2.1 2.1 0 0 1-3-3L3 7M10 6l1.5-1.5a2.1 2.1 0 0 1 3 3L13 9M6 6L4.5 4.5M10 10l1.5 1.5" />
    </Stroke>
  );
}

export function TrashIcon({ size = 14, ...rest }: IconProps) {
  return (
    <Stroke size={size} width={1.6} join {...rest}>
      <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5" />
    </Stroke>
  );
}

export function SwitchIcon({ size = 14, ...rest }: IconProps) {
  return (
    <Stroke size={size} width={1.5} join {...rest}>
      <path d="M5 6l3-3 3 3M5 10l3 3 3-3" />
    </Stroke>
  );
}

/** 도는 호. 움직임은 `animate-spin`이 만든다. */
export function SpinnerIcon({ size = 12, className = "", ...rest }: IconProps) {
  return (
    <Stroke
      size={size}
      width={1.8}
      className={`animate-spin ${className}`}
      {...rest}
    >
      <path d="M8 2a6 6 0 1 1-6 6" />
    </Stroke>
  );
}
