import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { useSession } from "../auth/auth";
import { useTheme, type Theme } from "../lib/theme";
import { StatusBadge } from "./bits";
import { Icon, type IconName } from "./Icon";

interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  end?: boolean;
  adminOnly?: boolean;
}

const GROUPS: { label: string; items: NavItem[] }[] = [
  {
    label: "Workspace",
    items: [
      { to: "/", label: "Overview", icon: "overview", end: true },
      { to: "/jobs", label: "Jobs", icon: "jobs" },
      { to: "/workflows", label: "Workflows", icon: "workflows" },
      { to: "/schedules", label: "Schedules", icon: "schedules" },
      { to: "/workers", label: "Workers", icon: "workers" },
    ],
  },
  { label: "Developers", items: [{ to: "/keys", label: "API keys", icon: "keys" }] },
  {
    label: "Organisation",
    items: [
      { to: "/team", label: "Team", icon: "team" },
      { to: "/audit", label: "Audit log", icon: "audit", adminOnly: true },
      { to: "/settings", label: "Settings", icon: "settings" },
    ],
  },
];

const THEMES: { value: Theme; label: string; icon: IconName }[] = [
  { value: "system", label: "System", icon: "chart" },
  { value: "light", label: "Light", icon: "sun" },
  { value: "dark", label: "Dark", icon: "moon" },
];

const initials = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("") || "?";

/** The signed-in layout: sidebar navigation, a top bar with the user menu, and the page. */
export function AppShell({ children }: { children: ReactNode }) {
  const { me, signOut, canOperate } = useSession();
  const [theme, setTheme] = useTheme();
  const [navOpen, setNavOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  const menuRef = useRef<HTMLDivElement>(null);

  // Moving to another page closes the drawer and the menu. Adjusting state while rendering (not in
  // an effect) is the pattern React recommends for "reset when this value changes".
  const [lastPath, setLastPath] = useState(location.pathname);
  if (lastPath !== location.pathname) {
    setLastPath(location.pathname);
    setNavOpen(false);
    setMenuOpen(false);
  }

  useEffect(() => {
    if (!menuOpen) return;
    const onMouse = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onMouse);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onMouse);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  if (!me) return null;
  return (
    <div className="shell" data-nav={navOpen ? "open" : "closed"}>
      <aside className="sidebar" aria-label="Sidebar">
        <Link to="/" className="brand sidebar-brand">
          <span className="brand-mark">
            <Icon name="logo" />
          </span>
          WorkMesh
        </Link>
        <div className="org-chip" title={me.account.slug}>
          <span className="muted">Organisation</span>
          <strong>{me.account.name}</strong>
        </div>
        <nav aria-label="Main">
          {GROUPS.map((group) => (
            <div key={group.label}>
              <p className="nav-label">{group.label}</p>
              {group.items
                .filter((item) => !item.adminOnly || canOperate)
                .map((item) => (
                  <NavLink key={item.to} to={item.to} end={item.end ?? false}>
                    <Icon name={item.icon} />
                    {item.label}
                  </NavLink>
                ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-spacer" />
        {canOperate ? (
          <Link to="/submit" className="btn primary">
            <Icon name="send" /> Submit a job
          </Link>
        ) : (
          <p className="muted small" role="note">
            You have read-only access. Ask an admin if you need to change something.
          </p>
        )}
      </aside>
      <div className="scrim" onClick={() => setNavOpen(false)} aria-hidden="true" />

      <div className="shell-main">
        <header className="topbar">
          <button
            type="button"
            className="icon-button menu-button"
            aria-label="Open navigation"
            aria-expanded={navOpen}
            onClick={() => setNavOpen((v) => !v)}
          >
            <Icon name="menu" />
          </button>
          <div className="topbar-right">
            <div className="user-menu" ref={menuRef}>
              <button
                type="button"
                className="user-menu-button"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((v) => !v)}
              >
                <span className="avatar" aria-hidden="true">
                  {initials(me.user.name)}
                </span>
                <span className="visually-hidden">Account menu for </span>
                {me.user.name}
              </button>
              {menuOpen ? (
                <div className="menu" role="menu">
                  <div className="menu-header">
                    <strong>{me.user.name}</strong>
                    <span className="muted small">{me.user.email}</span>
                    <div style={{ marginTop: 6 }}>
                      <StatusBadge status={me.user.role} />
                    </div>
                  </div>
                  <p className="nav-label" style={{ margin: "6px 10px 2px" }}>
                    Theme
                  </p>
                  {THEMES.map((t) => (
                    <button
                      key={t.value}
                      type="button"
                      role="menuitemradio"
                      aria-checked={theme === t.value}
                      onClick={() => setTheme(t.value)}
                    >
                      <Icon name={t.icon} />
                      {t.label}
                      {theme === t.value ? <Icon name="check" /> : null}
                    </button>
                  ))}
                  <hr style={{ border: 0, borderTop: "1px solid var(--grid)", margin: "6px 0" }} />
                  <Link to="/settings" role="menuitem">
                    <Icon name="settings" /> Settings
                  </Link>
                  <button type="button" role="menuitem" onClick={() => void signOut()}>
                    <Icon name="logout" /> Sign out
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </header>
        <main className="app-main" id="main">
          {children}
        </main>
      </div>
    </div>
  );
}
