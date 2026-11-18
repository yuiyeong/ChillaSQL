import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";

const ITEMS = '[role^="menuitem"]:not(:disabled)';

const CloseContext = createContext<() => void>(() => {});

interface MenuProps {
  open: boolean;
  onClose(): void;
  /** menu를 이 element 아래에 붙인다. 이 element를 누르는 것은 "바깥"이 아니다(여닫기는 그 element가 정한다). */
  anchor: RefObject<HTMLElement | null>;
  /** `end`면 menu의 오른쪽 끝을 anchor의 오른쪽 끝에 맞춘다. 창 오른쪽 끝의 anchor에 쓴다. 기본은 `start`다. */
  align?: "start" | "end";
  /** `aria-label` */
  label: string;
  children: ReactNode;
}

/**
 * anchor 아래에 뜨는 menu. 열리면 첫 항목에 focus가 가고,
 * 위아래 화살표로 항목을 옮기고, `Escape`나 바깥 누르기로 닫는다.
 */
export function Menu({
  open,
  onClose,
  anchor,
  align = "start",
  label,
  children,
}: MenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const rect = anchor.current?.getBoundingClientRect();
    const menu = ref.current;
    if (!rect || !menu) return;
    menu.style.top = `${rect.bottom + 4}px`;
    if (align === "end") {
      menu.style.right = `${document.documentElement.clientWidth - rect.right}px`;
    } else {
      menu.style.left = `${rect.left}px`;
    }
  }, [open, anchor, align]);

  // 열릴 때만 첫 항목으로 간다. 다시 그려질 때마다 가면 화살표로 옮긴 자리를 잃는다.
  useEffect(() => {
    if (open) ref.current?.querySelector<HTMLElement>(ITEMS)?.focus();
  }, [open]);

  // inline arrow로 넘어온 onClose가 매번 달라도 listener를 다시 달지 않는다.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (ref.current?.contains(target) || anchor.current?.contains(target)) {
        return;
      }
      onCloseRef.current();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, anchor]);

  if (!open) return null;

  // Escape와 선택은 focus를 anchor로 돌려 준다. 바깥 누르기는 누른 곳이 focus를 가진다.
  const close = () => {
    anchor.current?.focus();
    onClose();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [
      ...(ref.current?.querySelectorAll<HTMLElement>(ITEMS) ?? []),
    ];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const move = (index: number) => {
      event.preventDefault();
      items[(index + items.length) % items.length]?.focus();
    };
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        close();
        break;
      case "ArrowDown":
        move(at + 1);
        break;
      case "ArrowUp":
        move(at <= 0 ? -1 : at - 1);
        break;
      case "Home":
        move(0);
        break;
      case "End":
        move(-1);
        break;
      case "Tab":
        onClose();
        break;
    }
  };

  return (
    <CloseContext value={close}>
      <div
        ref={ref}
        role="menu"
        aria-label={label}
        onKeyDown={onKeyDown}
        className="border-line-2 bg-bg-3 shadow-popover fixed z-50 min-w-48 rounded-lg border p-1"
      >
        {children}
      </div>
    </CloseContext>
  );
}

interface MenuItemProps {
  onSelect(): void;
  disabled?: boolean;
  /** `aria-keyshortcuts`. 항목 안의 Kbd는 읽어 주지 않으므로 단축키는 이것으로 알린다. */
  keyShortcuts?: string;
  /** 있으면 `menuitemradio`다. */
  checked?: boolean;
  children: ReactNode;
}

/** 고르면 `onSelect`를 부르고 menu를 닫는다. */
export function MenuItem({
  onSelect,
  disabled,
  keyShortcuts,
  checked,
  children,
}: MenuItemProps) {
  const close = useContext(CloseContext);
  const radio = checked !== undefined;
  return (
    <button
      type="button"
      role={radio ? "menuitemradio" : "menuitem"}
      aria-checked={radio ? checked : undefined}
      aria-keyshortcuts={keyShortcuts}
      disabled={disabled}
      onClick={() => {
        onSelect();
        close();
      }}
      className={`text-body text-fg hover:bg-accent/16 focus:bg-accent/16 disabled:text-fg-3 flex h-7 w-full cursor-pointer items-center gap-2.5 rounded-[5px] border-0 px-2.5 text-left focus:outline-none disabled:cursor-default disabled:hover:bg-transparent ${checked ? "bg-accent/16" : "bg-transparent"}`}
    >
      {children}
    </button>
  );
}

/** 항목 묶음 사이의 구분선. */
export function MenuSeparator() {
  return <div role="separator" className="bg-line-2 mx-1.5 my-1 h-px" />;
}
