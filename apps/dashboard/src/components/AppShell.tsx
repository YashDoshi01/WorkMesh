import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { useSession } from "../auth/auth";
import { useTheme, type Theme } from "../lib/theme";
import { StatusBadge } from "./bits";
import { CommandPalette } from "./CommandPalette";
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

const isMac = (): boolean => /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? "");

/** The signed-in layout: sidebar navigation, a top bar with search and the user menu, and the page. */
export function AppShell({ children }: { children: ReactNode }) {
  const { me, signOut, canOperate } = useSession();
  const [theme, setTheme] = useTheme();
  const [navOpen, setNavOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
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

  // Ctrl+K / Cmd+K opens the command menu from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

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
  const shortcut = isMac() ? "⌘K" : "Ctrl K";
  return (
    <div className="shell" data-nav={navOpen ? "open" : "closed"}>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <aside className="sidebar" aria-label="Sidebar">
        <Link to="/" className="brand sidebar-brand">
          <span className="brand-mark">
            <Icon name="logo" />
          </span>
          WorkMesh
        </Link>
        <div className="org-chip" title={me.account.slug}>
          <span className="org-avatar" aria-hidden="true">
            {initials(me.account.name)}
          </span>
          <span className="org-text">
            <span className="muted">Organisation</span>
            <strong>{me.account.name}</strong>
          </span>
        </div>
        <button type="button" className="search-trigger" onClick={() => setPaletteOpen(true)}>
          <Icon name="search" />
          <span>Search</span>
          <kbd>{shortcut}</kbd>
        </button>
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
          <Link to="/submit" className="btn primary sidebar-cta">
            <Icon name="send" /> Submit a job
          </Link>
        ) : (
          <p className="readonly-note small" role="note">
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
          <button
            type="button"
            className="search-trigger topbar-search"
            onClick={() => setPaletteOpen(true)}
            aria-label="Open command menu"
          >
            <Icon name="search" />
            <span>Jump to…</span>
            <kbd>{shortcut}</kbd>
          </button>
          <div className="topbar-right">
            <button
              type="button"
              className="icon-button"
              aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            >
              <Icon name={theme === "dark" ? "sun" : "moon"} />
            </button>
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
                <span className="user-name">{me.user.name}</span>
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
                  <hr className="menu-sep" />
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
        <main className="app-main" id="main" key={location.pathname}>
          {children}
        </main>
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}
