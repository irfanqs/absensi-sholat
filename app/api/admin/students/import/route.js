import { readJsonBody, requireAdmin, resultResponse } from "../../../../../lib/admin-auth.js";
import { importStudents } from "../../../../../lib/admin-students.js";
import { getSupabaseAdmin } from "../../../../../lib/supabase-admin.js";

export const maxDuration = 60;

export async function POST(request) {
  const auth = await requireAdmin(request);
  if (auth instanceof Response) return auth;
  const { body, error } = await readJsonBody(request);
  if (error) return error;
  const result = await importStudents(getSupabaseAdmin(), body.students);
  return resultResponse(result, ({ results }) => ({ results }));
}
