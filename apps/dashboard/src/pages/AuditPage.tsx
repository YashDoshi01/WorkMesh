import { useState } from "react";
import { Link } from "react-router-dom";
import { useSession } from "../auth/auth";
import { PageHeader, StatusBadge, Time } from "../components/bits";
import { DataView } from "../components/DataView";
import { useResource } from "../hooks/useResource";

function target(type: string, id: string) {
  const short = id.slice(0, 8);
  if (type === "job") return <Link to={`/jobs/${id}`}>job {short}</Link>;
  if (type === "workflow") return <Link to={`/workflows/${id}`}>workflow {short}</Link>;
  return (
    <span>
      {type} {short}
    </span>
  );
}

export function AuditPage() {
  const { canOperate } = useSession();
  if (!canOperate) {
    return (
      <>
        <PageHeader title="Audit log" />
        <p className="state state-empty">Only admins can see the audit log.</p>
      </>
    );
  }
  return <AuditLog />;
}

function AuditLog() {
  const { api } = useSession();
  const [trail, setTrail] = useState<string[]>([]);
  const [before, setBefore] = useState<string | undefined>(undefined);
  const audit = useResource(`audit:${before ?? ""}`, (s) => api.audit(before, s), {
    intervalMs: before === undefined ? 10_000 : undefined,
  });

  return (
    <>
      <PageHeader title="Audit log" />
      <p className="muted small">
        Every change made in your organisation, newest first. Job payloads, passwords and API keys
        are never recorded.
      </p>
      <DataView
        resource={audit}
        what="the audit log"
        isEmpty={(p) => p.items.length === 0}
        empty="Nothing has been changed from the dashboard yet."
      >
        {(page) => (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">When</th>
                    <th scope="col">Who</th>
                    <th scope="col">From</th>
                    <th scope="col">Action</th>
                    <th scope="col">Target</th>
                    <th scope="col">Details</th>
                  </tr>
                </thead>
                <tbody>
                  {page.items.map((e) => (
                    <tr key={e.id}>
                      <td>
                        <Time iso={e.at} />
                      </td>
                      <td>
                        <StatusBadge status={e.role} label={e.actor} />
                      </td>
                      <td className="mono">{e.clientIp ?? "–"}</td>
                      <td>
                        <code>{e.action}</code>
                      </td>
                      <td>{target(e.targetType, e.targetId)}</td>
                      <td className="small">
                        {Object.entries(e.details)
                          .map(([k, v]) => `${k}: ${String(v)}`)
                          .join(" · ") || "–"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <nav className="pager" aria-label="Pages">
              <button
                type="button"
                disabled={before === undefined}
                onClick={() => {
                  const previous = trail[trail.length - 1];
                  setTrail(trail.slice(0, -1));
                  setBefore(previous || undefined);
                }}
              >
                ← Newer
              </button>
              <button
                type="button"
                disabled={!page.nextBefore}
                onClick={() => {
                  setTrail([...trail, before ?? ""]);
                  setBefore(page.nextBefore ?? undefined);
                }}
              >
                Older →
              </button>
            </nav>
          </>
        )}
      </DataView>
    </>
  );
}
