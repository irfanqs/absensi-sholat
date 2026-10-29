import { toAuthPassword, usernameToEmail } from "./auth.js";

const USERNAME_PATTERN = /^[A-Za-z0-9._-]+$/;
const RESERVED_USERNAME = "guru";
const GENDERS = ["Laki-laki", "Perempuan"];

export function normalizeStudentName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/^(')?([a-z])/, (_, apostrophe = "", letter) => `${apostrophe}${letter.toUpperCase()}`)
    .replace(/(^|[\s-])([a-z])/g, (_, separator, letter) => `${separator}${letter.toUpperCase()}`)
    .trim();
}

function toText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  return null;
}

export function validateStudentInput(input, { requirePassword }) {
  const source = input && typeof input === "object" ? input : {};
  const nis = toText(source.nis);
  if (nis === null) return { error: "NIS tidak valid." };
  const name = normalizeStudentName(toText(source.name));
  if (!name) return { error: "Nama murid wajib diisi." };
  const className = toText(source.className);
  if (!className) return { error: "Kelas wajib diisi." };
  const username = toText(source.username);
  if (!username) return { error: "Username wajib diisi." };
  if (!USERNAME_PATTERN.test(username)) {
    return {
      error: "Username hanya boleh berisi huruf, angka, titik, garis bawah, atau tanda minus.",
    };
  }
  if (username.toLowerCase() === RESERVED_USERNAME) {
    return { error: "Username guru tidak dapat dipakai untuk murid." };
  }
  const genderText = toText(source.gender);
  if (genderText === null || (genderText && !GENDERS.includes(genderText))) {
    return { error: "Jenis kelamin tidak valid." };
  }
  const value = { nis, name, className, gender: genderText || null, username };
  if (requirePassword) {
    if (typeof source.password !== "string" || !source.password) {
      return { error: "Password wajib diisi." };
    }
    value.password = source.password;
  }
  return { value };
}

export const STUDENT_COLUMNS = "id,nis,name,class_name,gender,username,is_active";

const MAX_IMPORT = 100;
const IMPORT_CONCURRENCY = 5;
const BAN_DURATION = "876000h";
const E_USERNAME_TAKEN = "Username sudah digunakan.";
const E_NOT_FOUND = "Data murid tidak ditemukan.";
const E_NO_AUTH_USER = "Akun login murid belum tersedia.";

function failure(message, status) {
  return { error: message, status };
}

function serverFailure(error) {
  return failure(`Gagal menyimpan data murid: ${error?.message || "kesalahan tidak diketahui"}`, 500);
}

function isAuthEmailTaken(error) {
  return (
    error?.code === "email_exists" ||
    /already (been )?registered|already exists/i.test(error?.message || "")
  );
}

function isUniqueViolation(error) {
  return error?.code === "23505";
}

function toStudentRow(value) {
  return {
    nis: value.nis,
    name: value.name,
    class_name: value.className,
    gender: value.gender,
    username: value.username,
  };
}

async function findStudent(admin, id) {
  const { data, error } = await admin
    .from("students")
    .select("id,username,auth_user_id")
    .eq("id", String(id))
    .maybeSingle();
  if (error) return serverFailure(error);
  if (!data) return failure(E_NOT_FOUND, 404);
  return { data };
}

async function insertStudentWithAuth(admin, value) {
  const id = crypto.randomUUID();
  const { data: created, error: authError } = await admin.auth.admin.createUser({
    email: usernameToEmail(value.username),
    password: toAuthPassword(value.password),
    email_confirm: true,
    app_metadata: { role: "student", student_id: id },
  });
  if (authError) {
    return isAuthEmailTaken(authError) ? failure(E_USERNAME_TAKEN, 409) : serverFailure(authError);
  }
  const authUserId = created.user.id;
  const { data, error } = await admin
    .from("students")
    .insert({ id, ...toStudentRow(value), auth_user_id: authUserId })
    .select(STUDENT_COLUMNS)
    .single();
  if (error) {
    await admin.auth.admin.deleteUser(authUserId);
    return isUniqueViolation(error) ? failure(E_USERNAME_TAKEN, 409) : serverFailure(error);
  }
  return { data };
}

export async function createStudent(admin, input) {
  const { value, error } = validateStudentInput(input, { requirePassword: true });
  if (error) return failure(error, 400);
  return insertStudentWithAuth(admin, value);
}

export async function updateStudent(admin, id, input) {
  const { value, error } = validateStudentInput(input, { requirePassword: false });
  if (error) return failure(error, 400);
  const current = await findStudent(admin, id);
  if (current.error) return current;
  const { auth_user_id: authUserId, username: oldUsername } = current.data;

  const usernameChanged = String(oldUsername || "").toLowerCase() !== value.username.toLowerCase();
  if (usernameChanged) {
    // Auth answers a taken email on update with a generic 500, so check the table first.
    const { data: taken, error: takenError } = await admin
      .from("students")
      .select("id")
      .ilike("username", value.username.replace(/_/g, "\\_"))
      .neq("id", current.data.id)
      .limit(1);
    if (takenError) return serverFailure(takenError);
    if (taken.length) return failure(E_USERNAME_TAKEN, 409);
  }

  let previousEmail = null;
  if (authUserId && usernameChanged) {
    const { data: existing, error: readError } = await admin.auth.admin.getUserById(authUserId);
    if (readError) return serverFailure(readError);
    previousEmail = existing.user.email;
    const { error: emailError } = await admin.auth.admin.updateUserById(authUserId, {
      email: usernameToEmail(value.username),
      email_confirm: true,
    });
    if (emailError) {
      return isAuthEmailTaken(emailError) ? failure(E_USERNAME_TAKEN, 409) : serverFailure(emailError);
    }
  }

  const { data, error: updateError } = await admin
    .from("students")
    .update(toStudentRow(value))
    .eq("id", current.data.id)
    .select(STUDENT_COLUMNS)
    .single();
  if (updateError) {
    if (previousEmail) {
      await admin.auth.admin.updateUserById(authUserId, {
        email: previousEmail,
        email_confirm: true,
      });
    }
    return isUniqueViolation(updateError) ? failure(E_USERNAME_TAKEN, 409) : serverFailure(updateError);
  }
  return { data };
}

export async function deactivateStudent(admin, id) {
  const current = await findStudent(admin, id);
  if (current.error) return current;
  const authUserId = current.data.auth_user_id;
  if (authUserId) {
    const { error } = await admin.auth.admin.updateUserById(authUserId, {
      ban_duration: BAN_DURATION,
    });
    if (error) return serverFailure(error);
  }
  const { error } = await admin
    .from("students")
    .update({ is_active: false })
    .eq("id", current.data.id);
  if (error) {
    if (authUserId) {
      await admin.auth.admin.updateUserById(authUserId, { ban_duration: "none" });
    }
    return serverFailure(error);
  }
  return { data: { ok: true } };
}

export async function resetStudentPassword(admin, id, password) {
  if (typeof password !== "string" || !password) return failure("Password wajib diisi.", 400);
  const current = await findStudent(admin, id);
  if (current.error) return current;
  if (!current.data.auth_user_id) return failure(E_NO_AUTH_USER, 409);
  const { error } = await admin.auth.admin.updateUserById(current.data.auth_user_id, {
    password: toAuthPassword(password),
  });
  if (error) return serverFailure(error);
  return { data: { ok: true } };
}

async function fetchTakenUsernames(admin) {
  const pageSize = 1000;
  const taken = new Set();
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await admin
      .from("students")
      .select("id,username")
      .order("id")
      .range(from, from + pageSize - 1);
    if (error) return { error };
    for (const row of data) taken.add(String(row.username || "").trim().toLowerCase());
    if (data.length < pageSize) return { data: taken };
  }
}

export async function importStudents(admin, rows) {
  if (!Array.isArray(rows)) return failure("Data import tidak valid.", 400);
  if (rows.length > MAX_IMPORT) {
    return failure(`Maksimal ${MAX_IMPORT} murid per import.`, 400);
  }
  const { data: taken, error: readError } = await fetchTakenUsernames(admin);
  if (readError) return serverFailure(readError);

  const results = new Array(rows.length);
  const pending = [];
  rows.forEach((row, index) => {
    const username = toText(row?.username) || "";
    const { value, error } = validateStudentInput(row, { requirePassword: true });
    if (error) {
      results[index] = { username, status: "error", message: error };
      return;
    }
    const key = value.username.toLowerCase();
    if (taken.has(key)) {
      results[index] = { username, status: "duplicate", message: E_USERNAME_TAKEN };
      return;
    }
    taken.add(key);
    pending.push({ index, username, value });
  });

  let next = 0;
  async function worker() {
    while (next < pending.length) {
      const { index, username, value } = pending[next++];
      const result = await insertStudentWithAuth(admin, value);
      results[index] = result.error
        ? {
            username,
            status: result.status === 409 ? "duplicate" : "error",
            message: result.error,
          }
        : { username, status: "created" };
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(IMPORT_CONCURRENCY, pending.length) }, worker),
  );
  return { data: { results } };
}
