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
import LandingPage from "./pages/marketing/LandingPage";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/demo/*" element={<DemoApp />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

/**
 * Mounts the AppShell (sidebar + header + banners) and the demo's own
 * router. All paths inside are relative to `/demo`.
 */
function DemoApp() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<Navigate to="contracts" replace />} />
        <Route path="contracts" element={<ContractsPage />} />
        <Route path="contracts/:id" element={<ContractWorkspacePage />} />
        <Route path="playbooks" element={<PlaybooksPage />} />
        <Route path="playbooks/:id" element={<PlaybookDetailPage />} />
        <Route path="upload" element={<UploadPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="clause-library" element={<ClauseLibraryPage />} />
        <Route path="agreement-templates" element={<AgreementTemplatesPage />} />
        <Route
          path="agreement-templates/:id"
          element={<AgreementTemplateDetailPage />}
        />
        <Route path="*" element={<Navigate to="contracts" replace />} />
      </Routes>
    </AppShell>
  );
}
