import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useSession } from "../auth/auth";
import { Field, problems } from "../components/Field";
import { AuthLayout } from "./AuthLayout";

export function LoginPage() {
  const { signIn } = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email.trim(), password);
    } catch (err) {
      setError(problems(err).general ?? "Could not sign in.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout
      title="Sign in"
      subtitle="Welcome back. Sign in to your organisation."
      footer={
        <>
          New to WorkMesh? <Link to="/signup">Create an account</Link>
        </>
      }
    >
      <form className="form" onSubmit={(e) => void submit(e)}>
        {error ? (
          <p role="alert" className="banner banner-error">
            {error}
          </p>
        ) : null}
        <Field
          label="Email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Field
          label="Password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button type="submit" className="primary lg" disabled={busy || !email || !password}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <p className="muted small">
          Forgot your password? Ask an admin of your organisation to remove your account and invite
          you again.
        </p>
      </form>
    </AuthLayout>
  );
}
