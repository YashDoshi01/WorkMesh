import { useState, type FormEvent } from "react";
import type { ApiKey, CreatedKey } from "../api/schemas";
import { useSession } from "../auth/auth";
import {
  ConfirmButton,
  FeedbackBanner,
  PageHeader,
  StatusBadge,
  Time,
  feedbackFromError,
  type Feedback,
} from "../components/bits";
import { CopyButton } from "../components/CopyButton";
import { DataView } from "../components/DataView";
import { Field, problems } from "../components/Field";
import { Icon } from "../components/Icon";
import { Modal } from "../components/Modal";
import { useResource } from "../hooks/useResource";

const EXPIRY = [
  { value: "", label: "Never expires" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "1 year" },
];

function CreateKeyDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { api } = useSession();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"client" | "worker">("client");
  const [types, setTypes] = useState("");
  const [days, setDays] = useState("");
  const [busy, setBusy] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [general, setGeneral] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedKey | null>(null);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setFields({});
    setGeneral(null);
    try {
      const jobTypes = types
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      const key = await api.createKey({
        kind,
        name: name.trim(),
        ...(kind === "worker" && jobTypes.length > 0 ? { jobTypes } : {}),
        ...(days ? { expiresInDays: Number(days) } : {}),
      });
      setCreated(key);
      onCreated();
    } catch (err) {
      const p = problems(err);
      setFields(p.fields);
      setGeneral(p.general);
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    return (
      <Modal title="Your new API key" onClose={onClose}>
        <p className="banner banner-warning" role="note">
          <strong>Copy it now.</strong> For security this key is shown only once. We store only a
          fingerprint, so it cannot be shown again.
        </p>
        <div className="secret-box">
          <code data-testid="secret">{created.secret}</code>
          <CopyButton text={created.secret} />
        </div>
        <p className="muted small" style={{ marginTop: 12 }}>
          {created.kind === "worker"
            ? "Give it to your worker as WORKMESH_API_KEY."
            : "Give it to your application as the apiKey of new WorkMesh({ ... }), or send it as  Authorization: Bearer <key>."}
        </p>
        <div className="modal-actions">
          <button type="button" className="primary" onClick={onClose}>
            I have saved it
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Create an API key" onClose={onClose} closable={!busy}>
      <form className="form" onSubmit={(e) => void submit(e)} style={{ marginTop: 14 }}>
        {general ? (
          <p role="alert" className="banner banner-error">
            {general}
          </p>
        ) : null}
        <Field
          label="Name"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={fields.name}
          hint='So you can recognise it later, for example "billing service".'
        />
        <div className="field">
          <label htmlFor="key-kind">Type</label>
          <select
            id="key-kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as "client" | "worker")}
          >
            <option value="client">Client: submits and reads jobs</option>
            <option value="worker">Worker: runs jobs</option>
          </select>
        </div>
        {kind === "worker" ? (
          <Field
            label="Job types (optional)"
            value={types}
            onChange={(e) => setTypes(e.target.value)}
            error={fields.jobTypes}
            placeholder="email.send, report.build"
            hint="Limit this key to these job types. Leave empty to allow any."
          />
        ) : null}
        <div className="field">
          <label htmlFor="key-expiry">Expiry</label>
          <select id="key-expiry" value={days} onChange={(e) => setDays(e.target.value)}>
            {EXPIRY.map((e) => (
              <option key={e.value} value={e.value}>
                {e.label}
              </option>
            ))}
          </select>
        </div>
        <div className="modal-actions">
          <button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy || !name.trim()}>
            {busy ? "Creating…" : "Create key"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function KeyRow({
  k,
  canRevoke,
  onRevoke,
}: {
  k: ApiKey;
  canRevoke: boolean;
  onRevoke: () => Promise<void>;
}) {
  return (
    <tr>
      <th scope="row">
        {k.name}
        {k.jobTypes ? <p className="muted small">{k.jobTypes.join(", ")}</p> : null}
      </th>
      <td>
        <StatusBadge status={k.kind} label={k.kind === "worker" ? "Worker" : "Client"} />
      </td>
      <td>
        <code>wm_{k.prefix}…</code>
      </td>
      <td>
        <StatusBadge
          status={
            k.status === "active" ? "enabled" : k.status === "expired" ? "stale" : "cancelled"
          }
          label={k.status}
        />
      </td>
      <td>
        <Time iso={k.lastUsedAt} relative />
        {k.lastUsedAt ? null : <span className="muted"> never</span>}
      </td>
      <td>{k.expiresAt ? <Time iso={k.expiresAt} /> : <span className="muted">never</span>}</td>
      {canRevoke ? (
        <td>
          {k.status === "active" ? (
            <ConfirmButton label="Revoke" confirmLabel="Yes, revoke" danger onConfirm={onRevoke} />
          ) : null}
        </td>
      ) : null}
    </tr>
  );
}

export function KeysPage() {
  const { api, canOperate } = useSession();
  const keys = useResource("keys", (s) => api.keys(s), { intervalMs: 15_000 });
  const [creating, setCreating] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  async function revoke(k: ApiKey): Promise<void> {
    setFeedback(null);
    try {
      await api.revokeKey(k.id);
      setFeedback({
        kind: "success",
        message: `Revoked ${k.name}. It stopped working immediately.`,
      });
    } catch (err) {
      setFeedback(feedbackFromError(err));
    }
    keys.reload();
  }

  return (
    <>
      <PageHeader title="API keys">
        {canOperate ? (
          <button type="button" className="primary" onClick={() => setCreating(true)}>
            <Icon name="plus" /> Create key
          </button>
        ) : null}
      </PageHeader>
      <p className="muted">
        <strong>Client</strong> keys let your application submit and read jobs.{" "}
        <strong>Worker</strong> keys let a worker process claim and run them. Keys only ever see
        your organisation's data.
      </p>
      <FeedbackBanner feedback={feedback} />
      <DataView
        resource={keys}
        what="API keys"
        isEmpty={(items) => items.length === 0}
        empty={
          canOperate
            ? "No API keys yet. Create a client key to submit jobs and a worker key to run them."
            : "No API keys yet. An admin can create them."
        }
      >
        {(items) => (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Type</th>
                  <th scope="col">Key</th>
                  <th scope="col">Status</th>
                  <th scope="col">Last used</th>
                  <th scope="col">Expires</th>
                  {canOperate ? <th scope="col">Actions</th> : null}
                </tr>
              </thead>
              <tbody>
                {items.map((k) => (
                  <KeyRow key={k.id} k={k} canRevoke={canOperate} onRevoke={() => revoke(k)} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </DataView>
      {creating ? (
        <CreateKeyDialog onClose={() => setCreating(false)} onCreated={() => keys.reload()} />
      ) : null}
    </>
  );
}
