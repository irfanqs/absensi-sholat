import test from "node:test";
import assert from "node:assert/strict";
import { canLinkAuthUser, guruAccountState } from "./auth-migration.js";

test("canLinkAuthUser links only the student's own Auth user", () => {
  const own = { app_metadata: { role: "student", student_id: "s-1" } };
  assert.equal(canLinkAuthUser(own, "s-1"), true);
  assert.equal(canLinkAuthUser(own, "s-2"), false);
  assert.equal(canLinkAuthUser({ app_metadata: { role: "admin", student_id: "s-1" } }, "s-1"), false);
  assert.equal(canLinkAuthUser({ app_metadata: { role: "student" } }, "s-1"), false);
  assert.equal(canLinkAuthUser({ app_metadata: {} }, "s-1"), false);
  assert.equal(canLinkAuthUser({}, "s-1"), false);
});

test("guruAccountState accepts only an admin guru", () => {
  assert.equal(guruAccountState(undefined), "missing");
  assert.equal(guruAccountState({ app_metadata: { role: "admin" } }), "admin");
  assert.equal(guruAccountState({ app_metadata: { role: "student" } }), "foreign");
  assert.equal(guruAccountState({ app_metadata: {} }), "foreign");
});
