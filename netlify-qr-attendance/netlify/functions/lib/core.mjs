// Core API logic. It takes a "store" (Netlify Blobs in production, a Map in tests),
// so it can be tested without Netlify.
import crypto from "node:crypto";

const LOW_ATTENDANCE = 75;
const TOKEN_LIFETIME_MS = 12 * 60 * 60 * 1000;
const MAX_ROSTER = 2000;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (m) => new HttpError(400, m);

const reply = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

// ---------------------------------------------------------------- small helpers
const enc = (roll) => encodeURIComponent(String(roll).trim().toLowerCase()); // storage key for a student ID
const newId = (bytes = 5) => crypto.randomBytes(bytes).toString("hex");
const pct = (a, b) => (b ? Math.round((1000 * a) / b) / 10 : 0);
const byRoll = (a, b) => a.roll.localeCompare(b.roll, undefined, { numeric: true, sensitivity: "base" });
const byDateAsc = (a, b) => (a.date + a.start).localeCompare(b.date + b.start);
const clean = (v, max) => String(v ?? "").trim().slice(0, max);
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

// ---------------------------------------------------------------- login tokens (stateless, signed)
function secretOf(env) {
  return env.SECRET_KEY || "dev-secret-" + (env.ADMIN_PASSWORD || "admin123");
}
function signToken(payload, env) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", secretOf(env)).update(body).digest("base64url");
  return `${body}.${sig}`;
}
function verifyToken(token, env, now) {
  const [body, sig] = String(token || "").split(".");
  if (!body || !sig) return false;
  const expect = crypto.createHmac("sha256", secretOf(env)).update(body).digest("base64url");
  if (!safeEqual(sig, expect)) return false;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString());
    return p.role === "admin" && p.exp > now;
  } catch { return false; }
}

// ---------------------------------------------------------------- storage layout
// courses                      -> [{id, code, name}]
// roster/<courseId>            -> [{roll, name}]
// sessions                     -> [{id, courseId, title, date, start, end, openUntil, createdAt}]
// att/<sessionId>/<studentKey> -> {roll, at, source}      one key per check-in (created with onlyIfNew)
// dev/<sessionId>/<deviceId>   -> {k}                      which student a phone has already used
function makeDb(store) {
  const j = async (key, fallback) => (await store.get(key, { type: "json" })) ?? fallback;
  return {
    store,
    courses: () => j("courses", []),
    saveCourses: (v) => store.setJSON("courses", v),
    roster: (id) => j(`roster/${id}`, []),
    saveRoster: (id, v) => store.setJSON(`roster/${id}`, v),
    sessions: () => j("sessions", []),
    saveSessions: (v) => store.setJSON("sessions", v),
    async keys(prefix) { return (await store.list({ prefix })).blobs.map((b) => b.key); },
    async deleteAll(prefix) { await Promise.all((await this.keys(prefix)).map((k) => store.delete(k))); },
  };
}

// Map(studentKey -> {at, source}). Reads each record only when times are needed.
async function attendance(db, sid, withTimes = false) {
  const keys = await db.keys(`att/${sid}/`);
  const map = new Map();
  if (!withTimes) {
    keys.forEach((k) => map.set(k.split("/")[2], {}));
    return map;
  }
  const rows = await Promise.all(keys.map((k) => db.store.get(k, { type: "json" })));
  keys.forEach((k, i) => { if (rows[i]) map.set(k.split("/")[2], rows[i]); });
  return map;
}

const isOpen = (s, now) => (s.openUntil || 0) > now;
const secondsLeft = (s, now) => Math.max(0, Math.floor(((s.openUntil || 0) - now) / 1000));

async function findSession(db, id) {
  const s = (await db.sessions()).find((x) => x.id === id);
  if (!s) throw new HttpError(404, "Session not found.");
  return s;
}
async function findCourse(db, id) {
  const c = (await db.courses()).find((x) => x.id === id);
  if (!c) throw new HttpError(404, "Course not found.");
  return c;
}

async function sessionRow(db, s, now, rosterCache, codes) {
  if (!rosterCache.has(s.courseId)) rosterCache.set(s.courseId, await db.roster(s.courseId));
  const roster = rosterCache.get(s.courseId);
  const att = await attendance(db, s.id);
  const present = roster.filter((r) => att.has(enc(r.roll))).length;
  return { ...s, courseCode: codes.get(s.courseId) || "?", isOpen: isOpen(s, now), present, total: roster.length };
}

async function sessionDetail(db, s, now) {
  const course = await findCourse(db, s.courseId);
  const roster = (await db.roster(s.courseId)).slice().sort(byRoll);
  const att = await attendance(db, s.id, true);
  const rows = roster.map((r) => {
    const a = att.get(enc(r.roll));
    return { roll: r.roll, name: r.name, at: a?.at || null, source: a?.source || null };
  });
  const present = rows.filter((r) => r.at).length;
  return { session: s, course, roster: rows, present, total: rows.length,
           isOpen: isOpen(s, now), secondsLeft: secondsLeft(s, now) };
}

async function removeSessionData(db, sid) {
  await db.deleteAll(`att/${sid}/`);
  await db.deleteAll(`dev/${sid}/`);
}

function parseStudents(text) {
  const out = [];
  for (let line of String(text || "").split(/\r?\n/)) {
    line = line.trim();
    if (!line) continue;
    let roll, name;
    const m = line.match(/^([^,;\t]+)[,;\t](.*)$/);
    if (m) { roll = m[1]; name = m[2]; }
    else {
      const p = line.match(/^(\S+)\s+(.+)$/);
      if (!p) continue;
      roll = p[1]; name = p[2];
    }
    roll = roll.trim().replace(/^"|"$/g, "");
    name = name.trim().replace(/^"|"$/g, "");
    if (!roll || !name) continue;
    if (["roll", "roll_no", "id", "student id", "student_id"].includes(roll.toLowerCase())) continue;
    out.push({ roll: roll.slice(0, 40), name: name.slice(0, 100) });
  }
  return out;
}

// ---------------------------------------------------------------- routes
const routes = [];
const route = (method, pattern, fn, admin = true) =>
  routes.push({ method, pat: pattern.split("/").filter(Boolean), fn, admin });

function matchRoute(method, parts) {
  for (const r of routes) {
    if (r.method !== method || r.pat.length !== parts.length) continue;
    const params = {};
    let ok = true;
    r.pat.forEach((seg, i) => {
      if (seg.startsWith(":")) params[seg.slice(1)] = decodeURIComponent(parts[i]);
      else if (seg !== parts[i]) ok = false;
    });
    if (ok) return { r, params };
  }
  return null;
}

// ---- public: login
route("POST", "/login", async (c) => {
  const user = String(c.body.username ?? ""), pass = String(c.body.password ?? "");
  const okUser = safeEqual(user, c.env.ADMIN_USERNAME || "admin");
  const okPass = safeEqual(pass, c.env.ADMIN_PASSWORD || "admin123");
  if (!(okUser && okPass)) throw new HttpError(401, "Wrong username or password.");
  return { token: signToken({ role: "admin", exp: c.now + TOKEN_LIFETIME_MS }, c.env) };
}, false);

// ---- public: what a student sees after scanning
route("GET", "/public/sessions/:id", async (c) => {
  const s = await findSession(c.db, c.params.id);
  const course = await findCourse(c.db, s.courseId);
  return { id: s.id, courseCode: course.code, courseName: course.name, title: s.title,
           date: s.date, start: s.start, end: s.end,
           isOpen: isOpen(s, c.now), secondsLeft: secondsLeft(s, c.now) };
}, false);

// ---- public: student submits attendance
route("POST", "/public/sessions/:id/attend", async (c) => {
  const s = await findSession(c.db, c.params.id);
  if (!isOpen(s, c.now)) throw new HttpError(409, "Attendance is closed for this session. Ask your instructor to reopen it.");
  const rollIn = clean(c.body.roll, 40);
  if (!rollIn) throw bad("Enter your student ID.");
  const course = await findCourse(c.db, s.courseId);
  const student = (await c.db.roster(s.courseId)).find((r) => enc(r.roll) === enc(rollIn));
  if (!student) throw new HttpError(404, `Student ID ${rollIn} is not on the class list for ${course.code}. Check the ID and try again.`);

  const key = enc(student.roll);
  const attKey = `att/${s.id}/${key}`;
  const device = /^[A-Za-z0-9_-]{8,64}$/.test(String(c.body.device || "")) ? c.body.device : "";

  const existing = await c.db.store.get(attKey, { type: "json" });
  if (existing) return { status: "already", name: student.name, roll: student.roll, at: existing.at };

  if (device) {
    const used = await c.db.store.get(`dev/${s.id}/${device}`, { type: "json" });
    if (used && used.k !== key) throw new HttpError(403, "This phone has already been used to mark attendance for another student in this session.");
  }
  // Atomic: only one request can ever create this key, so duplicates are impossible.
  const at = new Date(c.now).toISOString();
  const res = await c.db.store.setJSON(attKey, { roll: student.roll, at, source: "qr" }, { onlyIfNew: true });
  if (res && res.modified === false) {
    const again = await c.db.store.get(attKey, { type: "json" });
    return { status: "already", name: student.name, roll: student.roll, at: again?.at || at };
  }
  if (device) await c.db.store.setJSON(`dev/${s.id}/${device}`, { k: key }, { onlyIfNew: true });
  return { status: "ok", name: student.name, roll: student.roll, at };
}, false);

// ---- admin: dashboard
route("GET", "/admin/summary", async (c) => {
  const courses = await c.db.courses();
  const sessions = await c.db.sessions();
  const rosters = await Promise.all(courses.map((x) => c.db.roster(x.id)));
  const records = (await c.db.keys("att/")).length;
  const codes = new Map(courses.map((x) => [x.id, x.code]));
  const cache = new Map(courses.map((x, i) => [x.id, rosters[i]]));
  const latest = sessions.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 5);
  const recent = await Promise.all(latest.map((s) => sessionRow(c.db, s, c.now, cache, codes)));
  return { stats: { courses: courses.length, students: rosters.reduce((n, r) => n + r.length, 0),
                    sessions: sessions.length, records },
           courses, recent };
});

// ---- admin: courses
route("GET", "/admin/courses", async (c) => {
  const courses = (await c.db.courses()).slice().sort((a, b) => a.code.localeCompare(b.code));
  const sessions = await c.db.sessions();
  return Promise.all(courses.map(async (x) => ({
    ...x, students: (await c.db.roster(x.id)).length,
    sessions: sessions.filter((s) => s.courseId === x.id).length })));
});

route("POST", "/admin/courses", async (c) => {
  const code = clean(c.body.code, 20).toUpperCase(), name = clean(c.body.name, 100);
  if (!code || !name) throw bad("Enter both a course code and a course name.");
  const courses = await c.db.courses();
  if (courses.some((x) => x.code === code)) throw new HttpError(409, `Course code ${code} already exists.`);
  const course = { id: newId(), code, name };
  await c.db.saveCourses([...courses, course]);
  return course;
});

route("GET", "/admin/courses/:id", async (c) => {
  const course = await findCourse(c.db, c.params.id);
  return { course, students: (await c.db.roster(course.id)).slice().sort(byRoll) };
});

route("DELETE", "/admin/courses/:id", async (c) => {
  const course = await findCourse(c.db, c.params.id);
  const sessions = await c.db.sessions();
  await Promise.all(sessions.filter((s) => s.courseId === course.id).map((s) => removeSessionData(c.db, s.id)));
  await c.db.saveSessions(sessions.filter((s) => s.courseId !== course.id));
  await c.db.store.delete(`roster/${course.id}`);
  await c.db.saveCourses((await c.db.courses()).filter((x) => x.id !== course.id));
  return { ok: true };
});

route("POST", "/admin/courses/:id/students", async (c) => {
  const course = await findCourse(c.db, c.params.id);
  const roster = await c.db.roster(course.id);
  const incoming = c.body.bulk !== undefined
    ? parseStudents(c.body.bulk)
    : [{ roll: clean(c.body.roll, 40), name: clean(c.body.name, 100) }];
  if (incoming.some((s) => !s.roll || !s.name)) throw bad("Enter both a student ID and a name.");
  const seen = new Set(roster.map((r) => enc(r.roll)));
  let added = 0, skipped = 0;
  for (const s of incoming) {
    if (seen.has(enc(s.roll)) || roster.length >= MAX_ROSTER) { skipped++; continue; }
    seen.add(enc(s.roll));
    roster.push(s);
    added++;
  }
  if (added) await c.db.saveRoster(course.id, roster);
  if (c.body.bulk === undefined && !added) throw new HttpError(409, `Student ID ${incoming[0].roll} is already in this course.`);
  return { added, skipped };
});

route("DELETE", "/admin/courses/:id/students/:roll", async (c) => {
  const course = await findCourse(c.db, c.params.id);
  const key = enc(c.params.roll);
  const roster = await c.db.roster(course.id);
  await c.db.saveRoster(course.id, roster.filter((r) => enc(r.roll) !== key));
  const sessions = (await c.db.sessions()).filter((s) => s.courseId === course.id);
  await Promise.all(sessions.map((s) => c.db.store.delete(`att/${s.id}/${key}`)));
  return { ok: true };
});

// ---- admin: sessions
route("GET", "/admin/sessions", async (c) => {
  const { course = "", from = "", to = "" } = c.query;
  const courses = await c.db.courses();
  const codes = new Map(courses.map((x) => [x.id, x.code]));
  let list = await c.db.sessions();
  if (course) list = list.filter((s) => s.courseId === course);
  if (from) list = list.filter((s) => s.date >= from);
  if (to) list = list.filter((s) => s.date <= to);
  list.sort((a, b) => byDateAsc(b, a));
  const cache = new Map();
  return Promise.all(list.map((s) => sessionRow(c.db, s, c.now, cache, codes)));
});

route("POST", "/admin/sessions", async (c) => {
  const { courseId, date, start, end } = c.body;
  const course = await findCourse(c.db, courseId);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "") || !/^\d{2}:\d{2}$/.test(start || "") || !/^\d{2}:\d{2}$/.test(end || ""))
    throw bad("Check the date and class time.");
  const windowMin = Math.max(1, Math.min(parseInt(c.body.window, 10) || 15, 600));
  const s = { id: newId(9), courseId: course.id, title: clean(c.body.title, 100) || `${course.code} class`,
              date, start, end, openUntil: c.now + windowMin * 60000, createdAt: c.now };
  await c.db.saveSessions([...(await c.db.sessions()), s]);
  return s;
});

route("GET", "/admin/sessions/:id", async (c) => sessionDetail(c.db, await findSession(c.db, c.params.id), c.now));

route("POST", "/admin/sessions/:id/open", async (c) => {
  const s = await findSession(c.db, c.params.id);
  const minutes = Math.max(1, Math.min(parseInt(c.body.minutes, 10) || 10, 600));
  await c.db.saveSessions((await c.db.sessions()).map((x) => (x.id === s.id ? { ...x, openUntil: c.now + minutes * 60000 } : x)));
  return { ok: true };
});

route("POST", "/admin/sessions/:id/close", async (c) => {
  const s = await findSession(c.db, c.params.id);
  await c.db.saveSessions((await c.db.sessions()).map((x) => (x.id === s.id ? { ...x, openUntil: c.now } : x)));
  return { ok: true };
});

route("DELETE", "/admin/sessions/:id", async (c) => {
  const s = await findSession(c.db, c.params.id);
  await removeSessionData(c.db, s.id);
  await c.db.saveSessions((await c.db.sessions()).filter((x) => x.id !== s.id));
  return { ok: true };
});

// Instructor confirmation: toggles a student present/absent.
route("POST", "/admin/sessions/:id/manual", async (c) => {
  const s = await findSession(c.db, c.params.id);
  const student = (await c.db.roster(s.courseId)).find((r) => enc(r.roll) === enc(c.body.roll));
  if (!student) throw new HttpError(404, "Student not found.");
  const key = `att/${s.id}/${enc(student.roll)}`;
  if (await c.db.store.get(key, { type: "json" })) {
    await c.db.store.delete(key);
    return { status: "removed" };
  }
  await c.db.store.setJSON(key, { roll: student.roll, at: new Date(c.now).toISOString(), source: "manual" });
  return { status: "added" };
});

// ---- admin: reports (also used by the CSV export in the browser)
route("GET", "/admin/reports", async (c) => {
  const { course: courseId = "", from = "", to = "", session = "", records = "" } = c.query;
  const course = await findCourse(c.db, courseId);
  let sessions = (await c.db.sessions()).filter((s) => s.courseId === course.id);
  if (session) sessions = sessions.filter((s) => s.id === session);
  if (from) sessions = sessions.filter((s) => s.date >= from);
  if (to) sessions = sessions.filter((s) => s.date <= to);
  sessions.sort(byDateAsc);
  const roster = (await c.db.roster(course.id)).slice().sort(byRoll);
  const atts = await Promise.all(sessions.map((s) => attendance(c.db, s.id, !!records)));

  const students = roster.map((r) => {
    const present = atts.filter((a) => a.has(enc(r.roll))).length;
    return { roll: r.roll, name: r.name, present, absent: sessions.length - present, pct: pct(present, sessions.length) };
  });
  const sessionRows = sessions.map((s, i) => {
    const present = roster.filter((r) => atts[i].has(enc(r.roll))).length;
    return { id: s.id, date: s.date, title: s.title, time: `${s.start}-${s.end}`,
             present, absent: roster.length - present, pct: pct(present, roster.length) };
  });
  const marks = students.reduce((n, r) => n + r.present, 0);
  const out = {
    course, lowThreshold: LOW_ATTENDANCE, totalSessions: sessions.length, totalStudents: roster.length,
    overall: pct(marks, sessions.length * roster.length),
    low: students.filter((r) => r.pct < LOW_ATTENDANCE).length,
    sessions: sessionRows, students,
  };
  if (records) {
    out.records = [];
    sessions.forEach((s, i) => roster.forEach((r) => {
      const a = atts[i].get(enc(r.roll));
      out.records.push({ date: s.date, session: s.title, time: `${s.start}-${s.end}`, roll: r.roll, name: r.name,
                         status: a ? "Present" : "Absent", markedAt: a?.at || "", source: a?.source || "" });
    }));
  }
  return out;
});

// ---------------------------------------------------------------- entry point
export async function handle(req, { store, env = {}, now = Date.now() }) {
  try {
    const url = new URL(req.url);
    const parts = url.pathname.replace(/^\/api/, "").split("/").filter(Boolean);
    const found = matchRoute(req.method, parts);
    if (!found) throw new HttpError(404, "Not found.");
    if (found.r.admin) {
      const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
      if (!verifyToken(token, env, now)) throw new HttpError(401, "Please sign in again.");
    }
    let body = {};
    if (req.method !== "GET" && req.method !== "DELETE") {
      try { body = (await req.json()) || {}; } catch { body = {}; }
    }
    const ctx = { req, env, now, store, db: makeDb(store), body, params: found.params,
                  query: Object.fromEntries(url.searchParams) };
    return reply(await found.r.fn(ctx));
  } catch (e) {
    if (e instanceof HttpError) return reply({ error: e.message }, e.status);
    console.error(e);
    return reply({ error: "Something went wrong on the server. Please try again." }, 500);
  }
}
