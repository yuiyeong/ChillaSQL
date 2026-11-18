export type TreeNode =
  | { kind: "folder"; name: string; path: string; children: TreeNode[] }
  | { kind: "file"; name: string; path: string };

type Folder = Extract<TreeNode, { kind: "folder" }>;

/** 각 단계에서 folder가 먼저 오고, 그 안은 이름의 `localeCompare` 순서다. */
function sortNodes(nodes: TreeNode[]): void {
  nodes.sort((a, b) =>
    a.kind === b.kind
      ? a.name.localeCompare(b.name)
      : a.kind === "folder"
        ? -1
        : 1,
  );
  for (const node of nodes) {
    if (node.kind === "folder") sortNodes(node.children);
  }
}

/** 프로젝트 안의 상대 경로(`queries/a.sql`)를 folder tree로 묶는다. */
export function buildTree(paths: readonly string[]): TreeNode[] {
  const root: TreeNode[] = [];
  const folders = new Map<string, Folder>();

  for (const path of paths) {
    const parts = path.split("/");
    let siblings = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const folderPath = parts.slice(0, i + 1).join("/");
      let folder = folders.get(folderPath);
      if (folder === undefined) {
        folder = {
          kind: "folder",
          name: parts[i],
          path: folderPath,
          children: [],
        };
        folders.set(folderPath, folder);
        siblings.push(folder);
      }
      siblings = folder.children;
    }
    siblings.push({ kind: "file", name: parts[parts.length - 1], path });
  }

  sortNodes(root);
  return root;
}

/** `home`으로 시작하는 경로의 그 부분을 `~`로 바꾼다. */
export function shortenHome(dir: string, home: string | null): string {
  if (home === null) return dir;
  if (dir === home) return "~";
  return dir.startsWith(`${home}/`) ? `~${dir.slice(home.length)}` : dir;
}

/** `-`, `_`, `.`, 공백으로 나눈 앞 두 낱말의 첫 글자. 낱말이 하나면 앞 두 글자. 대문자다. */
export function projectInitials(name: string): string {
  const words = name.split(/[-_.\s]+/).filter((word) => word.length > 0);
  const initials =
    words.length >= 2
      ? words[0][0] + words[1][0]
      : (words[0] ?? "").slice(0, 2);
  return initials.toUpperCase();
}
