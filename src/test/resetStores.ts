import { useTunnels } from "../features/connections/tunnelsStore";
import { useEditorStatus } from "../features/editor/editorStatus";
import { useTabs } from "../features/editor/tabsStore";
import { useProject } from "../features/project/projectStore";
import { useRuns } from "../features/query/runsStore";
import { useSchema } from "../features/schema/schemaStore";
import { resetDialogs } from "../shared/ui/dialogs";

/**
 * 탭, 실행, 프로젝트, 에디터 상태, 확인 dialog store를 처음 상태로 돌린다. 탭의 문서는 `useTabs.reset`이 닫는다.
 * 앞 test의 세션을 닫는 호출이 끝난 뒤에 돌아오므로 `vi.resetAllMocks()` 앞에 부른다.
 */
export async function resetStores(): Promise<void> {
  await useRuns.getState().reset();
  // spyOn이 바꾼 state object를 버린다.
  useRuns.setState(useRuns.getInitialState(), true);
  useTabs.getState().reset();
  useProject.setState(useProject.getInitialState(), true);
  useEditorStatus.setState(useEditorStatus.getInitialState(), true);
  useTunnels.setState(useTunnels.getInitialState(), true);
  useSchema.getState().reset();
  // 답을 기다리던 ask는 cancel로 끝내고 차례를 비운다.
  resetDialogs();
}
