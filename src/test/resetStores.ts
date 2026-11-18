import { useEditorStatus } from "../features/editor/editorStatus";
import { useTabs } from "../features/editor/tabsStore";
import { useProject } from "../features/project/projectStore";
import { useRuns } from "../features/query/runsStore";

/**
 * 탭, 실행, 프로젝트, 에디터 상태 store를 처음 상태로 돌린다. 탭의 문서는 `useTabs.reset`이 닫는다.
 * 앞 test의 세션을 닫는 호출이 끝난 뒤에 돌아오므로 `vi.resetAllMocks()` 앞에 부른다.
 */
export async function resetStores(): Promise<void> {
  await useRuns.getState().reset();
  // spyOn이 바꾼 state object를 버린다.
  useRuns.setState(useRuns.getInitialState(), true);
  useTabs.getState().reset();
  useProject.setState(useProject.getInitialState(), true);
  useEditorStatus.setState(useEditorStatus.getInitialState(), true);
}
