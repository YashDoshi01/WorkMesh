import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { ApiClient, ApiError } from "../api/client";
import type { Me, Role } from "../api/schemas";
import { keyStore } from "./keyStore";

export interface Session {
  me: Me | null;
  /** The API client. Only meaningful while `me` is set. */
  api: ApiClient;
  /** Validates the key against the server; resolves with the role, or throws ApiError. */
  signIn(key: string): Promise<Role>;
  signOut(): void;
  /** Convenience: may this user change things? (The server enforces it regardless.) */
  canOperate: boolean;
}

/** Exported so tests can provide a ready-made session; the app only uses <SessionProvider>. */
export const SessionContext = createContext<Session | null>(null);

export function SessionProvider({
  children,
  client,
}: {
  children: ReactNode;
  /** Tests provide a ready-made client; the app builds its own. */
  client?: ApiClient;
}) {
  const [me, setMe] = useState<Me | null>(null);
  // A key may have survived in this tab (a reload). Until the server confirms it, show nothing.
  const [restoring, setRestoring] = useState<boolean>(() => keyStore.get() !== null);

  const signOut = useCallback(() => {
    keyStore.set(null);
    setMe(null);
    setRestoring(false);
  }, []);

  const api = useMemo(
    () =>
      client ??
      new ApiClient({
        getKey: keyStore.get,
        // The server rejected our key (rotated, revoked): go back to the sign-in form.
        onUnauthorized: signOut,
      }),
    [client, signOut],
  );

  useEffect(() => {
    if (keyStore.get() === null) return;
    let cancelled = false;
    api
      .me()
      .then((identity) => {
        if (!cancelled) setMe(identity);
      })
      .catch(() => {
        if (!cancelled) signOut();
      })
      .finally(() => {
        if (!cancelled) setRestoring(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, signOut]);

  const signIn = useCallback(
    async (key: string): Promise<Role> => {
      const identity = await api.me(key);
      keyStore.set(key);
      setMe(identity);
      return identity.role;
    },
    [api],
  );

  const value = useMemo<Session>(
    () => ({ me, api, signIn, signOut, canOperate: me?.role === "operator" }),
    [me, api, signIn, signOut],
  );

  if (restoring) return <p role="status">Checking your session…</p>;
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession must be used inside <SessionProvider>");
  return session;
}

export { ApiError };
