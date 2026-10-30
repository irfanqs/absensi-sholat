import { signInWithUsername, toAuthPassword } from "./auth.js";
import { supabase } from "./supabase.js";

const STUDENT_PROFILE_COLUMNS = "id,nis,name,class_name,gender,username,is_active";
const E_CURRENT_PASSWORD = "Password saat ini tidak sesuai.";

export async function fetchOwnStudentProfile(userId) {
  const { data, error } = await supabase
    .from("students")
    .select(STUDENT_PROFILE_COLUMNS)
    .eq("auth_user_id", userId)
    .maybeSingle();
  return { data, error };
}

export async function changeOwnPassword(username, currentPassword, newPassword) {
  const verification = await signInWithUsername(supabase, username, currentPassword);
  if (verification.error) return E_CURRENT_PASSWORD;
  const { error } = await supabase.auth.updateUser({
    password: toAuthPassword(newPassword),
  });
  return error ? `Gagal mengubah password: ${error.message}` : null;
}

function toResult({ data, error }) {
  return error
    ? { data: null, error: error.message || "Permintaan gagal." }
    : { data: data ?? null, error: null };
}

export async function submitAttendance(status) {
  return toResult(await supabase.rpc("submit_attendance", { p_status: status }));
}

export async function submitLateAttendance(date, status) {
  return toResult(
    await supabase.rpc("submit_late_attendance", { p_date: date, p_status: status }),
  );
}

export async function adminMarkAttendance(studentId, date, status) {
  return toResult(
    await supabase.rpc("admin_mark_attendance", {
      p_student_id: String(studentId),
      p_date: date,
      p_status: status,
    }),
  );
}

export async function adminDeleteAttendance(id) {
  return toResult(await supabase.rpc("admin_delete_attendance", { p_id: String(id) }));
}

export async function adminSetHoliday(date, isHoliday) {
  return toResult(
    await supabase.rpc("admin_set_holiday", { p_date: date, p_is_holiday: isHoliday }),
  );
}

export async function adminSetPrayerSchedule({ enabled, start, end, attendanceStartDate }) {
  return toResult(
    await supabase.rpc("admin_set_prayer_schedule", {
      p_enabled: enabled,
      p_start: start,
      p_end: end,
      p_attendance_start_date: attendanceStartDate,
    }),
  );
}
