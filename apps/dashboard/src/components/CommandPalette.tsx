import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useSession } from "../auth/auth";
import { useTheme } from "../lib/theme";
import { Icon, type IconName } from "./Icon";

interface Command {
  id: string;
  label: string;
  hint: string;
  icon: IconName;
  run: () => void;
  /** Extra words that should also match. */
  keywords?: string;
}

/**
 * Press Ctrl+K (or Cmd+K) anywhere to jump to a page or run an action. Keyboard only works fully:
 * type to filter, up/down to choose, Enter to run, Escape to close.
 */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  // Mounted only while open, so every opening starts with an empty search and the first row chosen.
  return open ? <PaletteDialog onClose={onClose} /> : null;
}

function PaletteDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const { canOperate, signOut } = useSession();
  const [theme, setTheme] = useTheme();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const commands = useMemo<Command[]>(() => {
    const go = (to: string) => () => navigate(to);
    const list: Command[] = [
      { id: "overview", label: "Overview", hint: "Page", icon: "overview", run: go("/") },
      { id: "jobs", label: "Jobs", hint: "Page", icon: "jobs", run: go("/jobs") },
      {
        id: "workflows",
        label: "Workflows",
        hint: "Page",
        icon: "workflows",
        run: go("/workflows"),
      },
      {
        id: "schedules",
        label: "Schedules",
        hint: "Page",
        icon: "schedules",
        run: go("/schedules"),
      },
      { id: "workers", label: "Workers", hint: "Page", icon: "workers", run: go("/workers") },
      {
        id: "keys",
        label: "API keys",
        hint: "Page",
        icon: "keys",
        run: go("/keys"),
        keywords: "tokens secrets",
      },
      {
        id: "team",
        label: "Team",
        hint: "Page",
        icon: "team",
        run: go("/team"),
        keywords: "members invite",
      },
      {
        id: "settings",
        label: "Settings",
        hint: "Page",
        icon: "settings",
        run: go("/settings"),
        keywords: "password",
      },
    ];
    if (canOperate) {
      list.push(
        {
          id: "audit",
          label: "Audit log",
          hint: "Page",
          icon: "audit",
          run: go("/audit"),
          keywords: "history",
        },
        {
          id: "submit",
          label: "Submit a job",
          hint: "Action",
          icon: "send",
          run: go("/submit"),
          keywords: "new create",
        },
      );
    }
    list.push(
      {
        id: "theme",
        label: theme === "dark" ? "Switch to light theme" : "Switch to dark theme",
        hint: "Action",
        icon: theme === "dark" ? "sun" : "moon",
        run: () => setTheme(theme === "dark" ? "light" : "dark"),
        keywords: "appearance mode",
      },
      {
        id: "signout",
        label: "Sign out",
        hint: "Action",
        icon: "logout",
        run: () => void signOut(),
      },
    );
    return list;
  }, [navigate, canOperate, signOut, theme, setTheme]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => `${c.label} ${c.keywords ?? ""}`.toLowerCase().includes(q));
  }, [commands, query]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const run = (c: Command | undefined): void => {
    if (!c) return;
    onClose();
    c.run();
  };

  return (
    <div
      className="palette-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command menu">
        <div className="palette-input">
          <Icon name="search" />
          <input
            ref={inputRef}
            type="text"
            placeholder="Search pages and actions…"
            aria-label="Search pages and actions"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={shown[index] ? `palette-${shown[index].id}` : undefined}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setIndex(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setIndex((i) => Math.min(shown.length - 1, i + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setIndex((i) => Math.max(0, i - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                run(shown[index]);
              } else if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              }
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <ul id="palette-list" role="listbox" aria-label="Results">
          {shown.length === 0 ? (
            <li className="palette-empty">Nothing matches “{query}”.</li>
          ) : (
            shown.map((c, i) => (
              <li
                key={c.id}
                id={`palette-${c.id}`}
                role="option"
                aria-selected={i === index}
                className={i === index ? "palette-item is-active" : "palette-item"}
                onMouseMove={() => setIndex(i)}
                onClick={() => run(c)}
              >
                <Icon name={c.icon} />
                <span>{c.label}</span>
                <small>{c.hint}</small>
              </li>
            ))
          )}
        </ul>
        <div className="palette-foot">
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> to move
          </span>
          <span>
            <kbd>↵</kbd> to open
          </span>
        </div>
      </div>
    </div>
  );
}
