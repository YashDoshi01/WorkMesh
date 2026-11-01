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
import type { Me } from "../api/schemas";

export interface Session {
  /** Who is signed in; null when nobody is. */
  me: Me | null;
  api: ApiClient;
  signIn(email: string, password: string): Promise<void>;
  signUp(input: { orgName: string; name: string; email: string; password: string }): Promise<void>;
  acceptInvite(input: { token: string; name: string; password: string }): Promise<void>;
  signOut(): Promise<void>;
  /**
   * May this user change things? (They are an admin of their organisation.) The server enforces
   * it regardless; this only decides which buttons to show.
   */
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
  // On first load we ask the server whether a valid session cookie exists. Until it answers, show
  // nothing, so a signed-in user never sees a flash of the sign-in page.
  const [restoring, setRestoring] = useState(true);

  const api = useMemo(
    () =>
      client ??
      new ApiClient({
        // The server ended the session (expired, signed out elsewhere, removed from the team).
        onUnauthorized: () => setMe(null),
      }),
    [client],
  );

  useEffect(() => {
    let cancelled = false;
    api
      .session()
      .then((identity) => {
        if (!cancelled) setMe(identity);
      })
      .catch(() => {
        /* nobody is signed in (or the service is unreachable): show the public pages */
      })
      .finally(() => {
        if (!cancelled) setRestoring(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const signIn = useCallback(
    async (email: string, password: string) => setMe(await api.login({ email, password })),
    [api],
  );
  const signUp = useCallback(
    async (input: { orgName: string; name: string; email: string; password: string }) =>
      setMe(await api.signup(input)),
    [api],
  );
  const acceptInvite = useCallback(
    async (input: { token: string; name: string; password: string }) =>
      setMe(await api.acceptInvite(input)),
    [api],
  );
  const signOut = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setMe(null);
    }
  }, [api]);

  const value = useMemo<Session>(
    () => ({
      me,
      api,
      signIn,
      signUp,
      acceptInvite,
      signOut,
      canOperate: me?.user.role === "admin",
    }),
    [me, api, signIn, signUp, acceptInvite, signOut],
  );

  if (restoring) {
    return (
      <p role="status" className="boot">
        Loading…
      </p>
    );
  }
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession must be used inside <SessionProvider>");
  return session;
}

export { ApiError };
