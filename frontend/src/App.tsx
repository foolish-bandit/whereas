import { Navigate, Route, Routes } from "react-router-dom";

import AppShell from "./components/AppShell";
import ContractsPage from "./pages/ContractsPage";
import ContractWorkspacePage from "./pages/ContractWorkspacePage";
import PlaybookDetailPage from "./pages/PlaybookDetailPage";
import PlaybooksPage from "./pages/PlaybooksPage";
import UploadPage from "./pages/UploadPage";
import SettingsPage from "./pages/SettingsPage";
import ClauseLibraryPage from "./pages/ClauseLibraryPage";
import AgreementTemplatesPage from "./pages/AgreementTemplatesPage";
import AgreementTemplateDetailPage from "./pages/AgreementTemplateDetailPage";

export default function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<Navigate to="/contracts" replace />} />
        <Route path="/contracts" element={<ContractsPage />} />
        <Route path="/contracts/:id" element={<ContractWorkspacePage />} />
        <Route path="/playbooks" element={<PlaybooksPage />} />
        <Route path="/playbooks/:id" element={<PlaybookDetailPage />} />
        <Route path="/upload" element={<UploadPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/clause-library" element={<ClauseLibraryPage />} />
        <Route path="/agreement-templates" element={<AgreementTemplatesPage />} />
        <Route
          path="/agreement-templates/:id"
          element={<AgreementTemplateDetailPage />}
        />
        <Route path="*" element={<Navigate to="/contracts" replace />} />
      </Routes>
    </AppShell>
  );
}
