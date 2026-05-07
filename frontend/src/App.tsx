import { Navigate, Route, Routes } from "react-router-dom";

import AppShell from "./components/AppShell";
import ContractsPage from "./pages/ContractsPage";
import ContractWorkspacePage from "./pages/ContractWorkspacePage";
import UploadPage from "./pages/UploadPage";
import SettingsPage from "./pages/SettingsPage";

export default function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<Navigate to="/contracts" replace />} />
        <Route path="/contracts" element={<ContractsPage />} />
        <Route path="/contracts/:id" element={<ContractWorkspacePage />} />
        <Route path="/upload" element={<UploadPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/contracts" replace />} />
      </Routes>
    </AppShell>
  );
}
