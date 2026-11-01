import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { PageHeader } from "../components/bits";
import type { InviteInfo } from "../api/schemas";
import { useSession } from "../auth/auth";
import { Field, problems } from "../components/Field";
import { AuthLayout } from "./AuthLayout";
import { PasswordMeter } from "./SignupPage";

/**
 * The token travels in the URL FRAGMENT (`#token=...`): browsers never send a fragment to a
 * server, so the token does not end up in the gateway's access log or in a referrer header.
 */
export const tokenFromHash = (hash: string): string | null => {
  const value = new URLSearchParams(hash.replace(/^#/, "")).get("token");
  return value && value.length >= 20 ? value : null;
};

export function AcceptInvitePage() {
  const { api, me, acceptInvite, signOut } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const token = tokenFromHash(location.hash);
  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [invalid, setInvalid] = useState(token === null);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [general, setGeneral] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // True from the moment the invitee submits, so the page can tell "I just joined" from "I was
  // already signed in as somebody else when I opened this link".
  const [joined, setJoined] = useState(false);

  useEffect(() => {
    if (joined && me) navigate("/", { replace: true });
  }, [joined, me, navigate]);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    api
      .inviteInfo(token)
      .then((i) => !cancelled && setInfo(i))
      .catch(() => !cancelled && setInvalid(true));
    return () => {
      cancelled = true;
    };
  }, [api, token]);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!token) return;
    setBusy(true);
    setFields({});
    setGeneral(null);
    try {
      setJoined(true);
      await acceptInvite({ token, name: name.trim(), password });
    } catch (err) {
      setJoined(false);
      const p = problems(err);
      setFields(p.fields);
      setGeneral(p.general);
    } finally {
      setBusy(false);
    }
  }

  if (me && !joined) {
    return (
      <main className="app-main" id="main">
        <PageHeader title="You are already signed in" />
        <p>
          You are signed in as <strong>{me.user.email}</strong>. To accept an invitation for a
          different account, sign out first and then open the link again.
        </p>
        <button type="button" className="primary" onClick={() => void signOut()}>
          Sign out
        </button>
      </main>
    );
  }
  if (invalid) {
    return (
      <AuthLayout
        title="This invitation is not valid"
        subtitle="It may have expired, been used already, or been withdrawn. Ask an admin of your organisation for a new link."
        footer={<Link to="/login">Back to sign in</Link>}
      >
        <span />
      </AuthLayout>
    );
  }
  if (!info) {
    return (
      <AuthLayout title="Checking your invitation…">
        <p role="status" className="state state-loading">
          One moment
        </p>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout
      title={`Join ${info.accountName}`}
      subtitle={`You were invited as ${info.role === "admin" ? "an admin" : "a viewer"}. Choose a name and password for ${info.email}.`}
    >
      <form className="form" onSubmit={(e) => void submit(e)}>
        {general ? (
          <p role="alert" className="banner banner-error">
            {general}
          </p>
        ) : null}
        <Field
          label="Your name"
          autoComplete="name"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={fields.name}
        />
        <Field
          label="Password"
          type="password"
          autoComplete="new-password"
          required
          minLength={10}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={fields.password}
        >
          <PasswordMeter password={password} />
        </Field>
        <button type="submit" className="primary lg" disabled={busy || !name || !password}>
          {busy ? "Joining…" : "Join organisation"}
        </button>
      </form>
    </AuthLayout>
  );
}
