import { ProjectGate } from "./features/project/ProjectGate";
import { Workspace } from "./features/workspace/Workspace";
import { DialogHost } from "./shared/ui/DialogHost";

function App() {
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
