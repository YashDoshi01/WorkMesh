const STORAGE_KEY = "workmesh.apiKey";

// Only used when the browser refuses storage entirely (some privacy modes): the session then
// lasts until the page is reloaded instead of until the tab closes.
let fallback: string | null = null;

/**
 * Where the API key lives: sessionStorage, so it disappears when the tab closes and is never
 * shared between tabs.
 *
 * This is a deliberate trade-off, not a safe harbour: any script running on this page (an XSS
 * bug, a compromised dependency) could read it. The mitigations are a short-lived tab session,
 * no third-party scripts, and React's escaping of everything it renders. Phase 8 replaces static
 * keys with revocable, per-user credentials.
 */
export const keyStore = {
  get(): string | null {
    try {
      return sessionStorage.getItem(STORAGE_KEY);
    } catch {
      return fallback;
    }
  },
  set(key: string | null): void {
    try {
      if (key) sessionStorage.setItem(STORAGE_KEY, key);
      else sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      fallback = key;
    }
  },
};
