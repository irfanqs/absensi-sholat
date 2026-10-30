import assert from "node:assert/strict";
import { test } from "node:test";
import { selectReportStudents } from "./report-students.js";

const students = [
  { id: "a1", name: "Aktif Tanpa Absen", className: "9A", isActive: true },
  { id: "a2", name: "Aktif Kelas B", className: "9B", isActive: true },
  { id: "i1", name: "Nonaktif Ada Absen", className: "9A", isActive: false },
  { id: "i2", name: "Nonaktif Absen Lama", className: "9A", isActive: false },
  { id: "i3", name: "Nonaktif Kelas B", className: "9B", isActive: false },
];
const records = [
  { studentId: "i1", date: "2026-10-05", className: "9A", status: "Hadir" },
  { studentId: "i2", date: "2026-09-30", className: "9A", status: "Hadir" },
  { studentId: "i2", date: "2026-11-01", className: "9A", status: "Hadir" },
  { studentId: "i3", date: "2026-10-31", className: "9B", status: "Haid" },
];
const october = { startDate: "2026-10-01", endDate: "2026-10-31" };
const ids = (list) => list.map((student) => student.id).sort();

test("all classes: active students plus inactive with a record in the period", () => {
  assert.deepEqual(ids(selectReportStudents(students, records, october)), ["a1", "a2", "i1", "i3"]);
});

test("active student without records is included", () => {
  assert.ok(ids(selectReportStudents(students, [], october)).includes("a1"));
});

test("inactive student with records only outside the period is excluded", () => {
  assert.ok(!ids(selectReportStudents(students, records, october)).includes("i2"));
});

test("class filter is respected", () => {
  assert.deepEqual(
    ids(selectReportStudents(students, records, { ...october, className: "9A" })),
    ["a1", "i1"],
  );
  assert.deepEqual(
    ids(selectReportStudents(students, records, { ...october, className: "9B" })),
    ["a2", "i3"],
  );
});

test("numeric ids match string record ids", () => {
  const list = [{ id: 7, name: "Angka", className: "9A", isActive: false }];
  const rows = [{ studentId: "7", date: "2026-10-10" }];
  assert.equal(selectReportStudents(list, rows, october).length, 1);
});
