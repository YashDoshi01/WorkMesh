export type Strength = { level: 0 | 1 | 2 | 3; label: string };

/**
 * A rough guide shown while typing. The SERVER decides what is acceptable (length, common
 * passwords); this only helps a person see whether they are close.
 */
export function passwordStrength(password: string): Strength {
  if (password.length === 0) return { level: 0, label: "" };
  if (password.length < 10) return { level: 1, label: "Too short (at least 10 characters)" };
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(password)).length;
  const words = password.trim().split(/\s+/).length;
  if (password.length >= 16 || (password.length >= 12 && (classes >= 3 || words >= 3))) {
    return { level: 3, label: "Strong" };
  }
  return { level: 2, label: "Acceptable: longer is better" };
}
