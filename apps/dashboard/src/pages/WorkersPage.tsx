import { useSession } from "../auth/auth";
import { PageHeader, StatusBadge, Time } from "../components/bits";
import { DataView } from "../components/DataView";
import { useResource } from "../hooks/useResource";
import { formatDuration } from "../lib/format";

export function WorkersPage() {
  const { api } = useSession();
  const workers = useResource("workers", (s) => api.workers(s), { intervalMs: 5000 });
  return (
    <>
      <PageHeader title="Workers" />
      <DataView
        resource={workers}
        what="workers"
        isEmpty={(d) => d.items.length === 0}
        empty="No worker has contacted the API in the last 24 hours. Start one with `npm run dev:worker`."
      >
        {(d) => (
          <>
            <p className="muted small">
              A worker is shown as not responding when its last contact is older than{" "}
              {formatDuration(d.staleAfterMs / 1000)}. Workers silent for more than 24 hours are
              hidden.
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Worker</th>
                    <th scope="col">Health</th>
                    <th scope="col">Last contact</th>
                    <th scope="col" className="num">
                      Running
                    </th>
                    <th scope="col" className="num">
                      Can run
                    </th>
                    <th scope="col">Job types</th>
                  </tr>
                </thead>
                <tbody>
                  {d.items.map((w) => (
                    <tr key={w.id}>
                      <th scope="row">
                        {w.name} <span className="mono muted">{w.id.slice(0, 8)}</span>
                      </th>
                      <td>
                        <StatusBadge
                          status={w.health}
                          label={w.health === "alive" ? "alive" : "not responding"}
                        />
                      </td>
                      <td>
                        <Time iso={w.lastHeartbeatAt} relative />
                      </td>
                      <td className="num">{w.runningJobs}</td>
                      <td className="num">{w.concurrency} at once</td>
                      <td>
                        <ul className="chips">
                          {w.jobTypes.map((t) => (
                            <li key={t} className="chip">
                              {t}
                            </li>
                          ))}
                        </ul>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </DataView>
    </>
  );
}
