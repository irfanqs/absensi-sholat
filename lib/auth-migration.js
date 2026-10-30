// Pure decisions for scripts/migrate-auth-users.mjs (kept here so they can be tested).

export const E_FOREIGN_AUTH_USER =
  "Akun Auth dengan email ini bukan milik siswa ini — periksa manual.";
export const E_FOREIGN_GURU =
  "Akun Auth dengan email guru bukan admin — guru tidak dibuat, periksa manual.";

// An existing Auth user may be linked to a student only if the migration
// itself created it for that very student.
export function canLinkAuthUser(user, studentId) {
  const meta = user?.app_metadata ?? {};
  return meta.role === "student" && meta.student_id === studentId;
}

// "missing" (create it), "admin" (already there) or "foreign" (an Auth user
// holds the guru email but is not an admin: fail, never create or promote).
export function guruAccountState(user) {
  if (!user) return "missing";
  return user.app_metadata?.role === "admin" ? "admin" : "foreign";
}
