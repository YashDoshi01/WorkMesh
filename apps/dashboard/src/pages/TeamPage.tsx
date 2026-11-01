import { useState, type FormEvent } from "react";
import type { CreatedInvite, Member, Role } from "../api/schemas";
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

/** The link an admin hands to the invitee. The token is in the fragment, so it never reaches a server log. */
export function inviteLink(token: string): string {
  return `${window.location.origin}${import.meta.env.BASE_URL}invite#token=${token}`;
}

function InviteDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { api } = useSession();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("viewer");
  const [busy, setBusy] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [general, setGeneral] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedInvite | null>(null);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setFields({});
    setGeneral(null);
    try {
      setCreated(await api.createInvite({ email: email.trim(), role }));
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
    const link = inviteLink(created.token);
    return (
      <Modal title="Invitation ready" onClose={onClose}>
        <p>
          Send this link to <strong>{created.email}</strong>. No email is sent by WorkMesh, so share
          it yourself. It works once and expires in 7 days.
        </p>
        <div className="secret-box">
          <code data-testid="invite-link">{link}</code>
          <CopyButton text={link} />
        </div>
        <p className="banner banner-warning" role="note" style={{ marginTop: 12 }}>
          The link is shown only now. If you lose it, revoke the invitation and create another.
        </p>
        <div className="modal-actions">
          <button type="button" className="primary" onClick={onClose}>
            Done
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Invite a teammate" onClose={onClose} closable={!busy}>
      <form className="form" onSubmit={(e) => void submit(e)} style={{ marginTop: 14 }}>
        {general ? (
          <p role="alert" className="banner banner-error">
            {general}
          </p>
        ) : null}
        <Field
          label="Email"
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={fields.email}
        />
        <div className="field">
          <label htmlFor="invite-role">Role</label>
          <select id="invite-role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="viewer">Viewer: can see everything, change nothing</option>
            <option value="admin">Admin: can also manage jobs, keys and the team</option>
          </select>
        </div>
        <div className="modal-actions">
          <button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy || !email.trim()}>
            {busy ? "Creating…" : "Create invitation"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function MemberRow({
  m,
  you,
  canManage,
  onChange,
}: {
  m: Member;
  you: boolean;
  canManage: boolean;
  onChange: (action: () => Promise<unknown>, success: string) => Promise<void>;
}) {
  const { api } = useSession();
  return (
    <tr>
      <th scope="row">
        {m.name} {you ? <span className="muted">(you)</span> : null}
        <p className="muted small">{m.email}</p>
      </th>
      <td>
        {canManage ? (
          <select
            aria-label={`Role of ${m.name}`}
            value={m.role}
            onChange={(e) =>
              void onChange(
                () => api.changeRole(m.id, e.target.value as Role),
                `${m.name} is now ${e.target.value === "admin" ? "an admin" : "a viewer"}.`,
              )
            }
          >
            <option value="admin">Admin</option>
            <option value="viewer">Viewer</option>
          </select>
        ) : (
          <StatusBadge status={m.role} />
        )}
      </td>
      <td>
        <Time iso={m.lastLoginAt} relative />
      </td>
      <td>
        <Time iso={m.createdAt} />
      </td>
      {canManage ? (
        <td>
          <ConfirmButton
            label={you ? "Leave" : "Remove"}
            confirmLabel={you ? "Yes, leave" : "Yes, remove"}
            danger
            onConfirm={() => onChange(() => api.removeMember(m.id), `Removed ${m.name}.`)}
          />
        </td>
      ) : null}
    </tr>
  );
}

export function TeamPage() {
  const { api, me, canOperate } = useSession();
  const members = useResource("members", (s) => api.members(s), { intervalMs: 15_000 });
  // Only admins may list invitations; for a viewer this resolves to nothing without asking the server.
  const invites = useResource(
    `invites:${canOperate}`,
    (s) => (canOperate ? api.invites(s) : Promise.resolve([])),
    { intervalMs: canOperate ? 15_000 : undefined },
  );
  const [inviting, setInviting] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  async function change(action: () => Promise<unknown>, success: string): Promise<void> {
    setFeedback(null);
    try {
      await action();
      setFeedback({ kind: "success", message: success });
    } catch (err) {
      setFeedback(feedbackFromError(err));
    }
    members.reload();
    invites.reload();
  }

  return (
    <>
      <PageHeader title="Team">
        {canOperate ? (
          <button type="button" className="primary" onClick={() => setInviting(true)}>
            <Icon name="plus" /> Invite teammate
          </button>
        ) : null}
      </PageHeader>
      <p className="muted">
        <strong>Admins</strong> can submit and cancel jobs, manage schedules, API keys and the team.{" "}
        <strong>Viewers</strong> can see everything in the organisation and change nothing.
      </p>
      <FeedbackBanner feedback={feedback} />

      <DataView resource={members} what="team members">
        {(items) => (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Member</th>
                  <th scope="col">Role</th>
                  <th scope="col">Last sign-in</th>
                  <th scope="col">Joined</th>
                  {canOperate ? <th scope="col">Actions</th> : null}
                </tr>
              </thead>
              <tbody>
                {items.map((m) => (
                  <MemberRow
                    key={m.id}
                    m={m}
                    you={m.id === me?.user.id}
                    canManage={canOperate}
                    onChange={change}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </DataView>

      {canOperate ? (
        <section aria-labelledby="invites-h">
          <h2 id="invites-h">Pending invitations</h2>
          <DataView
            resource={invites}
            what="invitations"
            isEmpty={(items) => items.filter((i) => i.status === "open").length === 0}
            empty="No pending invitations."
          >
            {(items) => (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Email</th>
                      <th scope="col">Role</th>
                      <th scope="col">Expires</th>
                      <th scope="col">Status</th>
                      <th scope="col">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((i) => (
                      <tr key={i.id}>
                        <th scope="row">{i.email}</th>
                        <td>
                          <StatusBadge status={i.role} />
                        </td>
                        <td>
                          <Time iso={i.expiresAt} relative />
                        </td>
                        <td>
                          <StatusBadge
                            status={
                              i.status === "open"
                                ? "enabled"
                                : i.status === "expired"
                                  ? "stale"
                                  : "cancelled"
                            }
                            label={i.status}
                          />
                        </td>
                        <td>
                          {i.status === "open" ? (
                            <ConfirmButton
                              label="Revoke"
                              confirmLabel="Yes, revoke"
                              danger
                              onConfirm={() =>
                                change(
                                  () => api.revokeInvite(i.id),
                                  `Revoked the invitation for ${i.email}.`,
                                )
                              }
                            />
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </DataView>
        </section>
      ) : null}

      {inviting ? (
        <InviteDialog onClose={() => setInviting(false)} onCreated={() => invites.reload()} />
      ) : null}
    </>
  );
}
