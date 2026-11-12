import { ProjectGate } from "./features/project/ProjectGate";
import { Workspace } from "./features/workspace/Workspace";

function App() {
  return (
    <ProjectGate>
      <Workspace />
    </ProjectGate>
  );
}

export default App;
