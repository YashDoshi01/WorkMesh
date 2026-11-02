import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Icon } from "./Icon";

type ToastKind = "success" | "error" | "info";
interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastApi {
  show: (message: string, kind?: ToastKind) => void;
}

// Without a provider (for example in a test that renders one page) toasts silently do nothing,
// so no component has to care whether it is inside the app shell.
const ToastContext = createContext<ToastApi>({ show: () => undefined });

export const useToast = (): ToastApi => useContext(ToastContext);

const LIFETIME_MS = 4000;

/** Short, non-blocking confirmations ("Copied", "Key revoked"). Announced politely to screen readers. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);

  const dismiss = useCallback(
    (id: number) => setItems((all) => all.filter((t) => t.id !== id)),
    [],
  );
  const show = useCallback(
    (message: string, kind: ToastKind = "success") => {
      const id = next.current++;
      setItems((all) => [...all.slice(-3), { id, kind, message }]);
      setTimeout(() => dismiss(id), LIFETIME_MS);
    },
    [dismiss],
  );
  const api = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toasts" role="region" aria-label="Notifications" aria-live="polite">
        {items.map((t) => (
          <div
            key={t.id}
            className={`toast toast-${t.kind}`}
            role={t.kind === "error" ? "alert" : "status"}
          >
            <Icon name={t.kind === "error" ? "alert" : "success"} />
            <span>{t.message}</span>
            <button
              type="button"
              className="icon-button"
              aria-label="Dismiss notification"
              onClick={() => dismiss(t.id)}
            >
              <Icon name="close" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
