import test from "node:test";
import assert from "node:assert/strict";
import {
  ADMIN_IDLE_LIMIT_MS,
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
