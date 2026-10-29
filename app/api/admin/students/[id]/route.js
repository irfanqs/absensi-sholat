import { readJsonBody, requireAdmin, resultResponse } from "../../../../../lib/admin-auth.js";
import { deactivateStudent, updateStudent } from "../../../../../lib/admin-students.js";
import { getSupabaseAdmin } from "../../../../../lib/supabase-admin.js";

export async function PATCH(request, { params }) {
  const auth = await requireAdmin(request);
  if (auth instanceof Response) return auth;
  const { id } = await params;
  const { body, error } = await readJsonBody(request);
  if (error) return error;
  const result = await updateStudent(getSupabaseAdmin(), id, body);
  return resultResponse(result, (student) => ({ student }));
}

export async function DELETE(request, { params }) {
  const auth = await requireAdmin(request);
  if (auth instanceof Response) return auth;
  const { id } = await params;
  const result = await deactivateStudent(getSupabaseAdmin(), id);
  return resultResponse(result, () => ({ ok: true }));
}
