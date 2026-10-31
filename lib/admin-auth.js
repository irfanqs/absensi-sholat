import "server-only";
import { getSupabaseAdmin } from "./supabase-admin.js";

const E_SESSION = "Sesi tidak valid. Silakan login ulang.";
const E_NOT_ADMIN = "Hanya guru yang dapat melakukan aksi ini.";
const E_BODY = "Data permintaan tidak valid.";

export async function requireAdmin(request) {
  const header = request.headers.get("authorization") || "";
  const match = header.match(/^Bearer\s+(\S+)$/i);
  if (!match) return Response.json({ error: E_SESSION }, { status: 401 });
  const { data, error } = await getSupabaseAdmin().auth.getUser(match[1]);
  if (error || !data?.user) return Response.json({ error: E_SESSION }, { status: 401 });
  if (data.user.app_metadata?.role !== "admin") {
    return Response.json({ error: E_NOT_ADMIN }, { status: 403 });
  }
  return { user: data.user };
}

export async function readJsonBody(request) {
  try {
    const body = await request.json();
    if (body && typeof body === "object" && !Array.isArray(body)) return { body };
  } catch {
    // Invalid JSON falls through to the error response.
  }
  return { error: Response.json({ error: E_BODY }, { status: 400 }) };
}

export function resultResponse(result, toBody, status = 200) {
  if (result.error) return Response.json({ error: result.error }, { status: result.status });
  return Response.json(toBody(result.data), { status });
}
