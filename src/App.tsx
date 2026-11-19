import { ProjectGate } from "./features/project/ProjectGate";
import { useQuitRequests } from "./features/workspace/quit";
import { Workspace } from "./features/workspace/Workspace";
import { DialogHost } from "./shared/ui/DialogHost";

function App() {
  useQuitRequests();
  return (
    <>
      <ProjectGate>
        <Workspace />
      </ProjectGate>
      <DialogHost />
    </>
  );
}

export default App;
