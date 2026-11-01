import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { useSession } from "./auth/auth";
import { StatusBadge } from "./components/bits";
import { AuditPage } from "./pages/AuditPage";
import { JobDetailPage } from "./pages/JobDetailPage";
import { JobsPage } from "./pages/JobsPage";
import { LoginPage } from "./pages/LoginPage";
import { OverviewPage } from "./pages/OverviewPage";
import { SchedulesPage } from "./pages/SchedulesPage";
import { SubmitJobPage } from "./pages/SubmitJobPage";
import { WorkersPage } from "./pages/WorkersPage";
import { WorkflowDetailPage } from "./pages/WorkflowDetailPage";
import { WorkflowsPage } from "./pages/WorkflowsPage";

const NAV = [
  { to: "/", label: "Overview", end: true },
  { to: "/jobs", label: "Jobs" },
  { to: "/workflows", label: "Workflows" },
  { to: "/schedules", label: "Schedules" },
  { to: "/workers", label: "Workers" },
  { to: "/audit", label: "Audit log" },
  { to: "/submit", label: "Submit job" },
];

export function App() {
  const { me, signOut, canOperate } = useSession();
  if (!me) return <LoginPage />;

  return (
    <>
      <header className="app-header">
        <span className="brand">WorkMesh</span>
        <nav aria-label="Main">
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end ?? false}>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <span className="who">
          <StatusBadge status={me.role} />
          <button type="button" className="link-button" onClick={signOut}>
            Sign out
          </button>
        </span>
      </header>
      <main className="app-main">
        {canOperate ? null : (
          <p className="banner banner-info" role="note">
            You are signed in as a viewer: everything is read-only.
          </p>
        )}
        <Routes>
          <Route path="/" element={<OverviewPage />} />
          <Route path="/jobs" element={<JobsPage />} />
          <Route path="/jobs/:id" element={<JobDetailPage />} />
          <Route path="/workflows" element={<WorkflowsPage />} />
          <Route path="/workflows/:id" element={<WorkflowDetailPage />} />
          <Route path="/schedules" element={<SchedulesPage />} />
          <Route path="/workers" element={<WorkersPage />} />
          <Route path="/audit" element={<AuditPage />} />
          <Route path="/submit" element={<SubmitJobPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </>
  );
}
