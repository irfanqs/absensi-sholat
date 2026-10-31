export const AUTH_EMAIL_DOMAIN = "absensi-sholat.local";
export const AUTH_PASSWORD_PREFIX = "absensi:";

export const E_LOGIN = "Username atau password belum sesuai.";
export const E_LOGIN_RETRY =
  "Terlalu banyak percobaan atau koneksi bermasalah. Coba lagi sebentar.";
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

// `signIn` resolves to true (signed in), false (rejected) or "retry" (rate
// limit / network / server error). On "retry" the legacy session is kept so the
// next page load can try again; every other legacy key is always removed.
export async function migrateLegacySession(storage, signIn) {
  const credentials = readLegacyCredentials(storage);
  let result = "none";
  try {
    if (credentials) {
      const outcome = await signIn(credentials.username, credentials.password);
      if (outcome === "retry") result = "retry";
      else result = outcome ? "migrated" : "failed";
    }
  } finally {
    for (const key of LEGACY_STORAGE_KEYS) {
      if (result === "retry" && key === "dzuhur-session") continue;
      storage.removeItem(key);
    }
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
  let error;
  try {
    ({ error } = await client.auth.signInWithPassword({
      email,
      password: toAuthPassword(password),
    }));
  } catch {
    return { error: E_LOGIN_RETRY };
  }
  if (!error) return { error: null };
  return { error: isRetryableAuthError(error) ? E_LOGIN_RETRY : E_LOGIN };
}

// auth-js reports network failures and 5xx as AuthRetryableFetchError (status
// 0 or 5xx) and rate limits as AuthApiError with status 429. Everything else
// (400 invalid_credentials, banned user, ...) is a plain login failure.
export function isRetryableAuthError(error) {
  if (!error) return false;
  if (error.name === "AuthRetryableFetchError") return true;
  const status = Number(error.status);
  if (status === 0 || status === 429 || status >= 500) return true;
  return typeof error.code === "string" && error.code.startsWith("over_");
}
