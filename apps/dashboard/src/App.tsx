import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useSession } from "./auth/auth";
import { AppShell } from "./components/AppShell";
import { AcceptInvitePage } from "./pages/AcceptInvitePage";
import { AuditPage } from "./pages/AuditPage";
import { JobDetailPage } from "./pages/JobDetailPage";
import { JobsPage } from "./pages/JobsPage";
import { KeysPage } from "./pages/KeysPage";
import { LandingPage } from "./pages/LandingPage";
import { LoginPage } from "./pages/LoginPage";
import { OverviewPage } from "./pages/OverviewPage";
import { SchedulesPage } from "./pages/SchedulesPage";
import { SettingsPage } from "./pages/SettingsPage";
import { SignupPage } from "./pages/SignupPage";
import { SubmitJobPage } from "./pages/SubmitJobPage";
import { TeamPage } from "./pages/TeamPage";
import { WorkersPage } from "./pages/WorkersPage";
import { WorkflowDetailPage } from "./pages/WorkflowDetailPage";
import { WorkflowsPage } from "./pages/WorkflowsPage";

/**
 * Once signed in, the sign-in and sign-up pages are pointless. Send the person where they were
 * heading before they were asked to sign in (a deep link), or home. Doing it HERE, in the router,
 * means it happens the moment the session exists, whichever page created it.
 */
function AfterSignIn() {
  const from = (useLocation().state as { from?: { pathname: string; search?: string } } | null)
    ?.from;
  return <Navigate to={from ? `${from.pathname}${from.search ?? ""}` : "/"} replace />;
}

export function App() {
  const { me } = useSession();
  const location = useLocation();

  if (!me) {
    return (
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/signup" element={<SignupPage />} />
        <Route path="/invite" element={<AcceptInvitePage />} />
        {/* A deep link opened while signed out: sign in, then come back to it. */}
        <Route path="*" element={<Navigate to="/login" replace state={{ from: location }} />} />
      </Routes>
    );
  }

  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<OverviewPage />} />
        <Route path="/jobs" element={<JobsPage />} />
        <Route path="/jobs/:id" element={<JobDetailPage />} />
        <Route path="/workflows" element={<WorkflowsPage />} />
        <Route path="/workflows/:id" element={<WorkflowDetailPage />} />
        <Route path="/schedules" element={<SchedulesPage />} />
        <Route path="/workers" element={<WorkersPage />} />
        <Route path="/keys" element={<KeysPage />} />
        <Route path="/team" element={<TeamPage />} />
        <Route path="/audit" element={<AuditPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/submit" element={<SubmitJobPage />} />
        <Route path="/invite" element={<AcceptInvitePage />} />
        <Route path="/login" element={<AfterSignIn />} />
        <Route path="/signup" element={<AfterSignIn />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  );
}
