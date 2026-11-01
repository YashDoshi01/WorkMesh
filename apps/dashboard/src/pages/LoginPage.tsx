import { useState, type FormEvent } from "react";
import { ApiError, useSession } from "../auth/auth";

export function LoginPage() {
  const { signIn } = useSession();
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(key.trim());
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? "That API key was not accepted."
          : err instanceof ApiError
            ? err.message
            : "Could not sign in.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <h1>WorkMesh</h1>
      <p>Sign in with an API key from your server configuration.</p>
      <form onSubmit={(e) => void submit(e)}>
        <label htmlFor="api-key">API key</label>
        <input
          id="api-key"
          type="password"
          autoComplete="off"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          required
          aria-describedby={error ? "login-error" : undefined}
        />
        {error ? (
          <p id="login-error" role="alert" className="field-error">
            {error}
          </p>
        ) : null}
        <button type="submit" className="primary" disabled={busy || key.trim() === ""}>
          {busy ? "Checking…" : "Sign in"}
        </button>
      </form>
      <p className="muted small">
        The key is kept only in this browser tab and is cleared when you sign out or close the tab.
      </p>
    </main>
  );
}
