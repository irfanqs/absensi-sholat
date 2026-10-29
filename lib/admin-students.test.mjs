import test from "node:test";
import assert from "node:assert/strict";
import { validateStudentInput } from "./admin-students.js";

const VALID = {
  nis: "1001",
  name: "Uji Satu",
  className: "9A",
  gender: "Perempuan",
  username: "9A_Uji",
  password: "123",
};

test("validateStudentInput requires name, class and a safe username", () => {
  const options = { requirePassword: true };
  assert.ok(validateStudentInput({ ...VALID, name: "  " }, options).error);
  assert.ok(validateStudentInput({ ...VALID, className: "" }, options).error);
  assert.ok(validateStudentInput({ ...VALID, username: "a b" }, options).error);
  assert.ok(validateStudentInput({ ...VALID, username: "" }, options).error);
  const { value, error } = validateStudentInput(VALID, options);
  assert.equal(error, undefined);
  assert.deepEqual(value, {
    nis: "1001",
    name: "Uji Satu",
    className: "9A",
    gender: "Perempuan",
    username: "9A_Uji",
    password: "123",
  });
});

test("validateStudentInput reserves guru", () => {
  assert.ok(validateStudentInput({ name: "A", className: "9A", username: "GURU", password: "123" }, { requirePassword: true }).error);
});

test("validateStudentInput requires password only on create", () => {
  const { password, ...withoutPassword } = VALID;
  assert.ok(validateStudentInput(withoutPassword, { requirePassword: true }).error);
  const result = validateStudentInput(withoutPassword, { requirePassword: false });
  assert.equal(result.error, undefined);
  assert.equal(result.value.username, "9A_Uji");
  assert.equal("password" in result.value, false);
});

test("validateStudentInput normalizes name and gender", () => {
  const options = { requirePassword: false };
  assert.equal(validateStudentInput({ ...VALID, name: "  siti AMINAH " }, options).value.name, "Siti Aminah");
  assert.equal(validateStudentInput({ ...VALID, gender: "" }, options).value.gender, null);
  assert.ok(validateStudentInput({ ...VALID, gender: "X" }, options).error);
});
