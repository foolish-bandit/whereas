import type { ReactNode } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";

import AppShell from "./components/AppShell";
import AnalyticsPage from "./pages/AnalyticsPage";
import AgreementTemplateDetailPage from "./pages/AgreementTemplateDetailPage";
import AgreementTemplatesPage from "./pages/AgreementTemplatesPage";
import ApprovalPoliciesPage from "./pages/ApprovalPoliciesPage";
import ApprovalsLandingPage from "./pages/ApprovalsLandingPage";
import ApprovalTaskDetailPage from "./pages/ApprovalTaskDetailPage";
import ApprovalTasksPage from "./pages/ApprovalTasksPage";
import ApprovalWorkflowDetailPage from "./pages/ApprovalWorkflowDetailPage";
import ApprovalWorkflowsPage from "./pages/ApprovalWorkflowsPage";
import ApprovalWorkflowTemplatesPage from "./pages/ApprovalWorkflowTemplatesPage";
import ClauseLibraryPage from "./pages/ClauseLibraryPage";
import ContractWorkspacePage from "./pages/ContractWorkspacePage";
import ContractsPage from "./pages/ContractsPage";
import DashboardPage from "./pages/DashboardPage";
import DevComponentsPage from "./pages/DevComponentsPage";
import InboxPage from "./pages/InboxPage";
import IntakePage from "./pages/IntakePage";
import IntegrationsPage from "./pages/IntegrationsPage";
import KnownLimitationsPage from "./pages/KnownLimitationsPage";
import LandingPage from "./pages/marketing/LandingPage";
import PlaybookDetailPage from "./pages/PlaybookDetailPage";
import PlaybooksPage from "./pages/PlaybooksPage";
import PwaWelcomePage from "./pages/PwaWelcomePage";
import RequestDetailPage from "./pages/RequestDetailPage";
import RequestsPage from "./pages/RequestsPage";
import SettingsPage from "./pages/SettingsPage";
import UploadPage from "./pages/UploadPage";
import { isStandaloneDisplayMode } from "./lib/browserCapabilities";

export default function App() {
  const standalone = isStandaloneDisplayMode();

  return (
    <Routes>
      <Route
        path="/"
        element={
          standalone ? <Navigate to="/demo/welcome" replace /> : <LandingPage />
        }
      />
      <Route
        path="/intake"
        element={
          <StandaloneApp>
            <IntakePage />
          </StandaloneApp>
        }
      />
      <Route
        path="/requests"
        element={
          <StandaloneApp>
            <RequestsPage />
          </StandaloneApp>
        }
      />
      <Route
        path="/requests/templates"
        element={
          <StandaloneApp>
            <AgreementTemplatesPage />
          </StandaloneApp>
        }
      />
      <Route
        path="/requests/templates/:id"
        element={
          <StandaloneApp>
            <AgreementTemplateDetailPage />
          </StandaloneApp>
        }
      />
      <Route
        path="/requests/:id"
        element={
          <StandaloneApp>
            <RequestDetailPage />
          </StandaloneApp>
        }
      />
      <Route
        path="/dev/components"
        element={
          <StandaloneApp>
            <DevComponentsPage />
          </StandaloneApp>
        }
      />
      <Route path="/demo/*" element={<DemoApp />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function StandaloneApp({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}

function DemoApp() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<Navigate to="welcome" replace />} />
        <Route path="welcome" element={<PwaWelcomePage />} />
        <Route path="dashboard" element={<DashboardPage />} />
        <Route path="analytics" element={<AnalyticsPage />} />
        <Route path="intake" element={<IntakePage />} />

        <Route path="repository" element={<ContractsPage />} />
        <Route path="repository/:id" element={<ContractWorkspacePage />} />
        <Route path="contracts" element={<ContractsPage />} />
        <Route path="contracts/:id" element={<ContractWorkspacePage />} />

        <Route path="playbooks" element={<PlaybooksPage />} />
        <Route path="playbooks/:id" element={<PlaybookDetailPage />} />
        <Route path="upload" element={<UploadPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="integrations" element={<IntegrationsPage />} />
        <Route path="known-limitations" element={<KnownLimitationsPage />} />

        <Route path="clause-manager" element={<ClauseLibraryPage />} />
        <Route path="clause-library" element={<ClauseLibraryPage />} />

        <Route path="agreement-templates" element={<AgreementTemplatesPage />} />
        <Route
          path="agreement-templates/:id"
          element={<AgreementTemplateDetailPage />}
        />
        <Route path="requests/templates" element={<AgreementTemplatesPage />} />
        <Route
          path="requests/templates/:id"
          element={<AgreementTemplateDetailPage />}
        />

        <Route path="requests" element={<RequestsPage />} />
        <Route path="requests/:id" element={<RequestDetailPage />} />

        <Route path="approvals" element={<ApprovalsEntry />} />
        <Route path="approvals/workflows" element={<ApprovalWorkflowsPage />} />
        <Route
          path="approvals/workflows/:id"
          element={<ApprovalWorkflowDetailPage />}
        />
        <Route
          path="approvals/templates"
          element={<ApprovalWorkflowTemplatesPage />}
        />
        <Route
          path="approvals/policies"
          element={<ApprovalPoliciesPage />}
        />
        <Route path="approvals/tasks" element={<ApprovalTasksPage />} />
        <Route
          path="approvals/tasks/:id"
          element={<ApprovalTaskDetailPage />}
        />

        <Route path="inbox" element={<InboxPage />} />
        <Route path="approval-workflows" element={<ApprovalWorkflowsPage />} />
        <Route
          path="approval-templates"
          element={<ApprovalWorkflowTemplatesPage />}
        />
        <Route path="approval-policies" element={<ApprovalPoliciesPage />} />

        <Route path="*" element={<Navigate to="dashboard" replace />} />
      </Routes>
    </AppShell>
  );
}

function ApprovalsEntry() {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  if (params.get("workflow_id")) {
    return <Navigate to={`workflows${location.search}`} replace />;
  }
  return <ApprovalsLandingPage />;
}
