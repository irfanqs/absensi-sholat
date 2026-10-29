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
