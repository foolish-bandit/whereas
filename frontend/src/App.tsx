import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import type { ReactNode } from "react";

import AppShell from "./components/AppShell";
import ContractsPage from "./pages/ContractsPage";
import ContractWorkspacePage from "./pages/ContractWorkspacePage";
import DashboardPage from "./pages/DashboardPage";
import PlaybookDetailPage from "./pages/PlaybookDetailPage";
import PlaybooksPage from "./pages/PlaybooksPage";
import UploadPage from "./pages/UploadPage";
import SettingsPage from "./pages/SettingsPage";
import ClauseLibraryPage from "./pages/ClauseLibraryPage";
import AgreementTemplatesPage from "./pages/AgreementTemplatesPage";
import AgreementTemplateDetailPage from "./pages/AgreementTemplateDetailPage";
import RequestDetailPage from "./pages/RequestDetailPage";
import RequestsPage from "./pages/RequestsPage";
import InboxPage from "./pages/InboxPage";
import ApprovalsLandingPage from "./pages/ApprovalsLandingPage";
import ApprovalTaskDetailPage from "./pages/ApprovalTaskDetailPage";
import ApprovalTasksPage from "./pages/ApprovalTasksPage";
import ApprovalWorkflowDetailPage from "./pages/ApprovalWorkflowDetailPage";
import ApprovalWorkflowsPage from "./pages/ApprovalWorkflowsPage";
import ApprovalWorkflowTemplatesPage from "./pages/ApprovalWorkflowTemplatesPage";
import ApprovalPoliciesPage from "./pages/ApprovalPoliciesPage";
import LandingPage from "./pages/marketing/LandingPage";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/requests" element={<StandaloneApp><RequestsPage /></StandaloneApp>} />
      <Route
        path="/requests/templates"
        element={<StandaloneApp><AgreementTemplatesPage /></StandaloneApp>}
      />
      <Route
        path="/requests/templates/:id"
        element={<StandaloneApp><AgreementTemplateDetailPage /></StandaloneApp>}
      />
      <Route path="/requests/:id" element={<StandaloneApp><RequestDetailPage /></StandaloneApp>} />
      <Route path="/demo/*" element={<DemoApp />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function StandaloneApp({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}

/**
 * Mounts the AppShell (sidebar + header + banners) and the demo's own
 * router. All paths inside are relative to `/demo`.
 *
 * Route map after the UI consolidation pass:
 *   - /repository (and legacy /contracts) → ContractsPage
 *   - /requests, /requests/templates → RequestsPage / AgreementTemplatesPage
 *   - /approvals → ApprovalsLandingPage (cards)
 *   - /approvals/{workflows,templates,policies,tasks} → workspace pages
 *   - /clause-manager (and legacy /clause-library) → ClauseLibraryPage
 *
 * Legacy routes (/contracts, /agreement-templates, /approval-workflows,
 * /approval-templates, /approval-policies, /inbox, /clause-library) are
 * kept for existing deep-links and tests.
 */
function DemoApp() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<Navigate to="dashboard" replace />} />
        <Route path="dashboard" element={<DashboardPage />} />

        {/* Repository (new label) + legacy /contracts alias. */}
        <Route path="repository" element={<ContractsPage />} />
        <Route path="repository/:id" element={<ContractWorkspacePage />} />
        <Route path="contracts" element={<ContractsPage />} />
        <Route path="contracts/:id" element={<ContractWorkspacePage />} />

        <Route path="playbooks" element={<PlaybooksPage />} />
        <Route path="playbooks/:id" element={<PlaybookDetailPage />} />
        <Route path="upload" element={<UploadPage />} />
        <Route path="settings" element={<SettingsPage />} />

        {/* Clause Manager (new label) + legacy /clause-library alias. */}
        <Route path="clause-manager" element={<ClauseLibraryPage />} />
        <Route path="clause-library" element={<ClauseLibraryPage />} />

        {/* Agreement Templates live under Requests; the original
            route is kept for stability, and /requests/templates is an
            alias that nests it under the Requests workspace. */}
        <Route path="agreement-templates" element={<AgreementTemplatesPage />} />
        <Route
          path="agreement-templates/:id"
          element={<AgreementTemplateDetailPage />}
        />
        <Route
          path="requests/templates"
          element={<AgreementTemplatesPage />}
        />
        <Route
          path="requests/templates/:id"
          element={<AgreementTemplateDetailPage />}
        />

        <Route path="requests" element={<RequestsPage />} />
        <Route path="requests/:id" element={<RequestDetailPage />} />

        {/* Approvals workspace. /approvals is now a landing page with
            cards; /approvals?workflow_id=... is preserved as a deep
            link by forwarding to /approvals/workflows when the query
            param is present, so existing remediation links from
            PR #60–#61 keep working. */}
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

        {/* Legacy approval routes — kept so existing deep links and
            external bookmarks keep resolving. */}
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

/**
 * /approvals shows the landing page by default. PR #60–#61 wired the
 * approval-gate remediation links to /approvals?workflow_id=<id>; we
 * forward those to the workflows view so the deep-link expand-and-
 * scroll behavior keeps working without breaking the new cards UX.
 */
function ApprovalsEntry() {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  if (params.get("workflow_id")) {
    return <Navigate to={`workflows${location.search}`} replace />;
  }
  return <ApprovalsLandingPage />;
}
