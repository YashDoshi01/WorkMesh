import { Link } from "react-router-dom";
import { useSession } from "../auth/auth";
import { PageHeader, StatusBadge, Time } from "../components/bits";
import { DataView } from "../components/DataView";
import { ProgressBar } from "../components/ProgressBar";
import { useResource } from "../hooks/useResource";

export function WorkflowsPage() {
  const { api } = useSession();
  const workflows = useResource("workflows", (s) => api.workflows(s), { intervalMs: 5000 });
  return (
    <>
      <PageHeader title="Workflows" />
      <DataView
        resource={workflows}
        what="workflows"
        isEmpty={(items) => items.length === 0}
        empty="No workflows yet. Create one with POST /workflows; see docs/WORKFLOWS.md."
      >
        {(items) => (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Workflow</th>
                  <th scope="col">Status</th>
                  <th scope="col">Progress</th>
                  <th scope="col">Created</th>
                </tr>
              </thead>
              <tbody>
                {items.map((w) => (
                  <tr key={w.id}>
                    <td>
                      <Link to={`/workflows/${w.id}`}>{w.name || w.id.slice(0, 8)}</Link>
                    </td>
                    <td>
                      <StatusBadge status={w.status} />
                      {w.cancelRequested && w.status === "running" ? (
                        <span className="muted small"> (cancelling)</span>
                      ) : null}
                    </td>
                    <td>
                      <ProgressBar progress={w.progress} />
                    </td>
                    <td>
                      <Time iso={w.createdAt} relative />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </DataView>
    </>
  );
}
