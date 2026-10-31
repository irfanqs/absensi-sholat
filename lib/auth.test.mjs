import test from "node:test";
import assert from "node:assert/strict";
import { AuthApiError, AuthRetryableFetchError } from "@supabase/auth-js";
import {
  ADMIN_IDLE_LIMIT_MS,
  E_LOGIN_RETRY,
  LEGACY_STORAGE_KEYS,
  isAdminSessionExpired,
  migrateLegacySession,
  signInWithUsername,
  toAuthPassword,
  usernameToEmail,
} from "./auth.js";

const E_LOGIN = "Username atau password belum sesuai.";

function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      map.set(key, String(value));
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

function fullStorage(session) {
  const data = {};
  for (const key of LEGACY_STORAGE_KEYS) data[key] = "x";
  data["dzuhur-session"] = session;
  return makeStorage(data);
}

function makeSignIn(result) {
  const calls = [];
  const fn = async (username, password) => {
    calls.push([username, password]);
    return result;
  };
  fn.calls = calls;
  return fn;
}

function assertAllLegacyCleared(storage) {
  for (const key of LEGACY_STORAGE_KEYS) assert.equal(storage.getItem(key), null);
}

test("usernameToEmail normalizes case and whitespace", () => {
  assert.equal(usernameToEmail(" 9D_Kevin "), "9d_kevin@absensi-sholat.local");
});

test("usernameToEmail rejects empty and unsafe usernames", () => {
  assert.throws(() => usernameToEmail("  "), { message: "Username tidak valid." });
  assert.throws(() => usernameToEmail("a b"));
  assert.throws(() => usernameToEmail("x@y"));
});

test("toAuthPassword keeps the password verbatim", () => {
  assert.equal(toAuthPassword("123"), "absensi:123");
  assert.equal(toAuthPassword(" 123"), "absensi: 123");
});

test("migrateLegacySession signs in legacy student and clears every legacy key", async () => {
  const storage = fullStorage(
    JSON.stringify({ role: "student", username: "9A_Irfan", password: "123" }),
  );
  const signIn = makeSignIn(true);
  assert.equal(await migrateLegacySession(storage, signIn), "migrated");
  assert.deepEqual(signIn.calls, [["9A_Irfan", "123"]]);
  assertAllLegacyCleared(storage);
});

test("migrateLegacySession returns failed when sign-in fails", async () => {
  const storage = fullStorage(
    JSON.stringify({ role: "student", username: "9A_Irfan", password: "123" }),
  );
  const signIn = makeSignIn(false);
  assert.equal(await migrateLegacySession(storage, signIn), "failed");
  assert.equal(signIn.calls.length, 1);
  assertAllLegacyCleared(storage);
});

test("migrateLegacySession keeps only the legacy session when sign-in must be retried", async () => {
  const session = JSON.stringify({ role: "student", username: "9A_Irfan", password: "123" });
  const storage = fullStorage(session);
  const signIn = makeSignIn("retry");
  assert.equal(await migrateLegacySession(storage, signIn), "retry");
  assert.equal(signIn.calls.length, 1);
  assert.equal(storage.getItem("dzuhur-session"), session);
  for (const key of LEGACY_STORAGE_KEYS) {
    if (key !== "dzuhur-session") assert.equal(storage.getItem(key), null);
  }
});

test("migrateLegacySession ignores admin and corrupt sessions", async () => {
  for (const session of [JSON.stringify({ role: "admin" }), "{"]) {
    const storage = fullStorage(session);
    const signIn = makeSignIn(true);
    assert.equal(await migrateLegacySession(storage, signIn), "none");
    assert.equal(signIn.calls.length, 0);
    assertAllLegacyCleared(storage);
  }
});

test("migrateLegacySession returns none without legacy data", async () => {
  const storage = makeStorage();
  const signIn = makeSignIn(true);
  assert.equal(await migrateLegacySession(storage, signIn), "none");
  assert.equal(signIn.calls.length, 0);
});

test("isAdminSessionExpired", () => {
  const now = Date.UTC(2026, 9, 30);
  assert.equal(isAdminSessionExpired(null, now), false);
  assert.equal(isAdminSessionExpired(now - ADMIN_IDLE_LIMIT_MS, now), false);
  assert.equal(isAdminSessionExpired(now - ADMIN_IDLE_LIMIT_MS - 1, now), true);
});

test("signInWithUsername maps any failure to the login message", async () => {
  const calls = [];
  const failing = {
    auth: {
      signInWithPassword: async (args) => {
        calls.push(args);
        return { error: { message: "Invalid login credentials" } };
      },
    },
  };
  assert.deepEqual(await signInWithUsername(failing, "9A_Irfan", "123"), { error: E_LOGIN });

  calls.length = 0;
  assert.deepEqual(await signInWithUsername(failing, "a b", "123"), { error: E_LOGIN });
  assert.equal(calls.length, 0);

  const ok = {
    auth: {
      signInWithPassword: async (args) => {
        calls.push(args);
        return { error: null };
      },
    },
  };
  assert.deepEqual(await signInWithUsername(ok, "9A_Irfan", "123"), { error: null });
  assert.deepEqual(calls, [
    { email: "9a_irfan@absensi-sholat.local", password: "absensi:123" },
  ]);
});

function clientReturning(error) {
  return { auth: { signInWithPassword: async () => ({ data: {}, error }) } };
}

test("signInWithUsername maps 400 invalid_credentials to the login message", async () => {
  const error = new AuthApiError("Invalid login credentials", 400, "invalid_credentials");
  assert.deepEqual(await signInWithUsername(clientReturning(error), "9A_Irfan", "1"), {
    error: E_LOGIN,
  });
});

test("signInWithUsername maps a 429 rate limit to the retry message", async () => {
  const error = new AuthApiError("Request rate limit reached", 429, "over_request_rate_limit");
  assert.deepEqual(await signInWithUsername(clientReturning(error), "9A_Irfan", "123"), {
    error: E_LOGIN_RETRY,
  });
});

test("signInWithUsername maps network and server errors to the retry message", async () => {
  for (const error of [
    new AuthRetryableFetchError("Failed to fetch", 0),
    new AuthRetryableFetchError("Bad Gateway", 502),
  ]) {
    assert.deepEqual(await signInWithUsername(clientReturning(error), "9A_Irfan", "123"), {
      error: E_LOGIN_RETRY,
    });
  }
  const throwing = {
    auth: {
      signInWithPassword: async () => {
        throw new TypeError("fetch failed");
      },
    },
  };
  assert.deepEqual(await signInWithUsername(throwing, "9A_Irfan", "123"), {
    error: E_LOGIN_RETRY,
  });
});
