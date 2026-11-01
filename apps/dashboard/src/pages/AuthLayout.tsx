import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Icon } from "../components/Icon";

const POINTS = [
  "Every job is saved before it is acknowledged, so nothing is lost if a server restarts.",
  "A crashed worker's jobs are picked up again automatically.",
  "Your organisation sees only its own jobs, keys and team.",
];

/** The two-column frame used by sign-in, sign-up and invitation pages. */
export function AuthLayout({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="auth">
      <aside className="auth-aside">
        <Link to="/" className="brand">
          <span className="brand-mark">
            <Icon name="logo" />
          </span>
          WorkMesh
        </Link>
        <div>
          <h2>Run background work you can trust.</h2>
          <ul>
            {POINTS.map((p) => (
              <li key={p}>
                <Icon name="check" />
                <span>{p}</span>
              </li>
            ))}
          </ul>
        </div>
        <small>Durable jobs, schedules and workflows for your applications.</small>
      </aside>
      <main className="auth-main" id="main">
        <div className="auth-card">
          <h1>{title}</h1>
          {subtitle ? <p className="muted">{subtitle}</p> : null}
          {children}
          {footer ? <p className="auth-switch">{footer}</p> : null}
        </div>
      </main>
    </div>
  );
}
