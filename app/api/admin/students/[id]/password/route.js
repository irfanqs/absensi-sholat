import { readJsonBody, requireAdmin, resultResponse } from "../../../../../../lib/admin-auth.js";
import { resetStudentPassword } from "../../../../../../lib/admin-students.js";
import { getSupabaseAdmin } from "../../../../../../lib/supabase-admin.js";

export async function POST(request, { params }) {
  const auth = await requireAdmin(request);
  if (auth instanceof Response) return auth;
  const { id } = await params;
  const { body, error } = await readJsonBody(request);
  if (error) return error;
  const result = await resetStudentPassword(getSupabaseAdmin(), id, body.password);
  return resultResponse(result, () => ({ ok: true }));
}
