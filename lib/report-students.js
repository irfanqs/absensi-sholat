// Students who belong in a report period: every active student, plus deactivated
// students who still have attendance in the period (their history stays in the rekap).
export function selectReportStudents(students, records, { startDate, endDate, className = "Semua kelas" }) {
  const withRecords = new Set(
    records
      .filter((item) => item.date >= startDate && item.date <= endDate)
      .map((item) => String(item.studentId)),
  );
  return students.filter(
    (student) =>
      (student.isActive !== false || withRecords.has(String(student.id))) &&
      (className === "Semua kelas" || student.className === className),
  );
}
