import type { Connection, Project } from "../shared/api/types";
import { useProject } from "../features/project/projectStore";

/** test용 접속. 바꿀 값만 `patch`로 준다. */
export function connection(
  name: string,
  patch: Partial<Connection> = {},
): Connection {
  return {
    name,
    host: "localhost",
    port: 5432,
    database: "app",
    user: "chilla",
    sslmode: "disable",
    sslrootcert: null,
    tunnel: null,
    color: null,
    ...patch,
  };
}

/** `demo` 프로젝트(`/p`)가 열린 상태로 project store를 바꾼다. */
export function openProjectWith(
  connections: Connection[] = [],
  files: string[] = [],
): Project {
  const project: Project = { name: "demo", dir: "/p", connections };
  useProject.setState(
    { ...useProject.getInitialState(), status: "ready", project, files },
    true,
  );
  return project;
}
