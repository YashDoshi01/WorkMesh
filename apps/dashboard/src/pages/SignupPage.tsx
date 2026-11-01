import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useSession } from "../auth/auth";
import { Field, problems } from "../components/Field";
import { passwordStrength } from "../lib/password";
import { AuthLayout } from "./AuthLayout";

export function PasswordMeter({ password }: { password: string }) {
  const { level, label } = passwordStrength(password);
  const cls = level === 1 ? "on-weak" : level === 2 ? "on-ok" : "on-strong";
  return (
    <>
      <div className="password-meter" aria-hidden="true">
        {[1, 2, 3].map((i) => (
          <span key={i} className={level >= i ? cls : ""} />
        ))}
      </div>
      <span className="visually-hidden" role="status">
        {label ? `Password strength: ${label}` : ""}
      </span>
      {label ? <span className="hint">{label}</span> : null}
    </>
  );
}

export function SignupPage() {
  const { signUp } = useSession();
  const [form, setForm] = useState({ orgName: "", name: "", email: "", password: "" });
  const [fields, setFields] = useState<Record<string, string>>({});
  const [general, setGeneral] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setFields({});
    setGeneral(null);
    try {
      await signUp({
        ...form,
        orgName: form.orgName.trim(),
        name: form.name.trim(),
        email: form.email.trim(),
      });
    } catch (err) {
      const p = problems(err);
      setFields(p.fields);
      setGeneral(p.general);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout
      title="Create your account"
      subtitle="Set up an organisation. You will be its first admin and can invite your team."
      footer={
        <>
          Already have an account? <Link to="/login">Sign in</Link>
        </>
      }
    >
      <form className="form" onSubmit={(e) => void submit(e)}>
        {general ? (
          <p role="alert" className="banner banner-error">
            {general}
          </p>
        ) : null}
        <Field
          label="Organisation name"
          autoComplete="organization"
          required
          value={form.orgName}
          onChange={set("orgName")}
          error={fields.orgName}
          hint="Your company or project. Everything you create belongs to it."
        />
        <Field
          label="Your name"
          autoComplete="name"
          required
          value={form.name}
          onChange={set("name")}
          error={fields.name}
        />
        <Field
          label="Work email"
          type="email"
          autoComplete="email"
          required
          value={form.email}
          onChange={set("email")}
          error={fields.email}
        />
        <Field
          label="Password"
          type="password"
          autoComplete="new-password"
          required
          minLength={10}
          value={form.password}
          onChange={set("password")}
          error={fields.password}
        >
          <PasswordMeter password={form.password} />
        </Field>
        <button
          type="submit"
          className="primary lg"
          disabled={busy || !form.orgName || !form.name || !form.email || !form.password}
        >
          {busy ? "Creating account…" : "Create account"}
        </button>
      </form>
    </AuthLayout>
  );
}
