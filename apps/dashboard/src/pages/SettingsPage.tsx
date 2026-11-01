import { useState, type FormEvent } from "react";
import { useSession } from "../auth/auth";
import { PageHeader, StatusBadge, Time } from "../components/bits";
import { Field, problems } from "../components/Field";
import { useTheme, type Theme } from "../lib/theme";
import { PasswordMeter } from "./SignupPage";

const THEMES: { value: Theme; label: string }[] = [
  { value: "system", label: "Match my system" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

function ChangePassword() {
  const { api } = useSession();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [general, setGeneral] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setFields({});
    setGeneral(null);
    setDone(false);
    try {
      await api.changePassword({ currentPassword: current, newPassword: next });
      setCurrent("");
      setNext("");
      setDone(true);
    } catch (err) {
      const p = problems(err);
      setFields(p.fields);
      setGeneral(p.general);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card form" onSubmit={(e) => void submit(e)} aria-labelledby="pw-h">
      <h2 id="pw-h">Change password</h2>
      <p className="muted small">
        Changing your password signs you out everywhere else, which is useful if you think someone
        else has your session.
      </p>
      {done ? (
        <p role="status" className="banner banner-success">
          Password changed. Other sessions were signed out.
        </p>
      ) : null}
      {general ? (
        <p role="alert" className="banner banner-error">
          {general}
        </p>
      ) : null}
      <Field
        label="Current password"
        type="password"
        autoComplete="current-password"
        required
        value={current}
        onChange={(e) => setCurrent(e.target.value)}
        error={fields.currentPassword}
      />
      <Field
        label="New password"
        type="password"
        autoComplete="new-password"
        required
        minLength={10}
        value={next}
        onChange={(e) => setNext(e.target.value)}
        error={fields.newPassword}
      >
        <PasswordMeter password={next} />
      </Field>
      <div>
        <button type="submit" className="primary" disabled={busy || !current || !next}>
          {busy ? "Saving…" : "Change password"}
        </button>
      </div>
    </form>
  );
}

export function SettingsPage() {
  const { me } = useSession();
  const [theme, setTheme] = useTheme();
  if (!me) return null;
  return (
    <>
      <PageHeader title="Settings" />
      <div className="card-grid">
        <section className="card" aria-labelledby="profile-h">
          <h2 id="profile-h">Your profile</h2>
          <dl className="facts">
            <div>
              <dt>Name</dt>
              <dd>{me.user.name}</dd>
            </div>
            <div>
              <dt>Email</dt>
              <dd>{me.user.email}</dd>
            </div>
            <div>
              <dt>Role</dt>
              <dd>
                <StatusBadge status={me.user.role} />
              </dd>
            </div>
            <div>
              <dt>Member since</dt>
              <dd>
                <Time iso={me.user.createdAt} />
              </dd>
            </div>
          </dl>
        </section>
        <section className="card" aria-labelledby="org-h">
          <h2 id="org-h">Organisation</h2>
          <dl className="facts">
            <div>
              <dt>Name</dt>
              <dd>{me.account.name}</dd>
            </div>
            <div>
              <dt>Identifier</dt>
              <dd>
                <code>{me.account.slug}</code>
              </dd>
            </div>
          </dl>
          <p className="muted small">
            Everything you create (jobs, schedules, API keys) belongs to this organisation, and only
            its members can see it.
          </p>
        </section>
      </div>

      <h2>Security</h2>
      <ChangePassword />

      <section className="card" aria-labelledby="appearance-h" style={{ marginTop: 16 }}>
        <h2 id="appearance-h">Appearance</h2>
        <div
          className="filter-row"
          role="radiogroup"
          aria-label="Theme"
          style={{ marginBottom: 0 }}
        >
          {THEMES.map((t) => (
            <button
              key={t.value}
              type="button"
              role="radio"
              aria-checked={theme === t.value}
              className={theme === t.value ? "chip chip-on" : "chip"}
              onClick={() => setTheme(t.value)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </section>
    </>
  );
}
