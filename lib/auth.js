export const AUTH_EMAIL_DOMAIN = "absensi-sholat.local";
export const AUTH_PASSWORD_PREFIX = "absensi:";

const E_LOGIN = "Username atau password belum sesuai.";
const E_USERNAME = "Username tidak valid.";
const USERNAME_PATTERN = /^[a-z0-9._-]+$/;

export const LEGACY_STORAGE_KEYS = [
  "dzuhur-session",
  "dzuhur-teacher-password",
  "dzuhur-supabase-cache-v2",
  "dzuhur-students",
  "dzuhur-attendances",
  "dzuhur-holidays",
  "dzuhur-prayer-schedule",
];

export const ADMIN_ACTIVITY_KEY = "dzuhur-admin-last-active";
export const ADMIN_IDLE_LIMIT_MS = 7 * 24 * 60 * 60 * 1000;

export function usernameToEmail(username) {
  const normalized = String(username ?? "").trim().toLowerCase();
  if (!normalized || !USERNAME_PATTERN.test(normalized)) {
    throw new Error(E_USERNAME);
  }
  return `${normalized}@${AUTH_EMAIL_DOMAIN}`;
}

export function toAuthPassword(password) {
  return `${AUTH_PASSWORD_PREFIX}${password}`;
}

function readLegacyCredentials(storage) {
  try {
    const raw = storage.getItem("dzuhur-session");
    if (!raw) return null;
    const session = JSON.parse(raw);
    if (
      session &&
      session.role === "student" &&
      typeof session.username === "string" &&
      typeof session.password === "string"
    ) {
      return { username: session.username, password: session.password };
    }
  } catch {
    // Corrupt JSON means no credentials.
  }
  return null;
}

export async function migrateLegacySession(storage, signIn) {
  const credentials = readLegacyCredentials(storage);
  let result = "none";
  try {
    if (credentials) {
      const ok = await signIn(credentials.username, credentials.password);
      result = ok ? "migrated" : "failed";
    }
  } finally {
    for (const key of LEGACY_STORAGE_KEYS) storage.removeItem(key);
  }
  return result;
}

export function isAdminSessionExpired(lastActive, now) {
  if (lastActive === null || lastActive === undefined) return false;
  return now - lastActive > ADMIN_IDLE_LIMIT_MS;
}

export async function signInWithUsername(client, username, password) {
  let email;
  try {
    email = usernameToEmail(username);
  } catch {
    return { error: E_LOGIN };
  }
  const { error } = await client.auth.signInWithPassword({
    email,
    password: toAuthPassword(password),
  });
  return { error: error ? E_LOGIN : null };
}
