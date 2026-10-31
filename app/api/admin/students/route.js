import { readJsonBody, requireAdmin, resultResponse } from "../../../../lib/admin-auth.js";
import { createStudent } from "../../../../lib/admin-students.js";
import { getSupabaseAdmin } from "../../../../lib/supabase-admin.js";

export async function POST(request) {
  const auth = await requireAdmin(request);
  if (auth instanceof Response) return auth;
  const { body, error } = await readJsonBody(request);
  if (error) return error;
  const result = await createStudent(getSupabaseAdmin(), body);
  return resultResponse(result, (student) => ({ student }), 201);
}
