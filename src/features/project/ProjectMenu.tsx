import type { RefObject } from "react";
import { t } from "../../shared/i18n/t";
import { Kbd } from "../../shared/ui/Kbd";
import { Menu, MenuItem, MenuSeparator } from "../../shared/ui/Menu";
import { switchProject } from "../workspace/commands";
import { shortcutKeys, shortcutLabel } from "../workspace/shortcuts";
import { useProject } from "./projectStore";

/**
 * sidebar의 프로젝트 이름을 눌렀을 때 열리는 menu(캔버스 Sidebar D). 지금 프로젝트는 menu를 연 button이
 * 머리에서 보이므로 목록에는 나머지 최근 프로젝트만 `Recent` 아래에 둔다. 맨 아래는 폴더 picker다.
 */
export function ProjectMenu({
  anchor,
  onClose,
}: {
  /** menu를 붙일 프로젝트 button */
  anchor: RefObject<HTMLElement | null>;
  onClose(): void;
}) {
  const current = useProject((s) => s.project?.dir);
  const recent = useProject((s) => s.recent);
  const others = recent.filter((project) => project.dir !== current);

  return (
    <Menu open anchor={anchor} onClose={onClose} label={t("sidebar.projects")}>
      {others.length > 0 && (
        <>
          <span className="text-label text-fg-2 block px-2.5 pt-1.5 pb-1 font-semibold tracking-[0.04em]">
            {t("project.recentShort")}
          </span>
          {others.map((project) => (
            <MenuItem
              key={project.dir}
              onSelect={() => void switchProject(project.dir)}
            >
              <span title={project.dir} className="max-w-[210px] truncate">
                {project.name}
              </span>
            </MenuItem>
          ))}
          <MenuSeparator />
        </>
      )}
      <MenuItem
        keyShortcuts={shortcutKeys("openProject")}
        onSelect={() => void switchProject()}
      >
        <span className="flex-1">{t("project.openShortcut")}</span>
        <Kbd>{shortcutLabel("openProject")}</Kbd>
      </MenuItem>
    </Menu>
  );
}
