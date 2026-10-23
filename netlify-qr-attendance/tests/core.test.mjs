import test from "node:test";
import assert from "node:assert/strict";
import { handle } from "../netlify/functions/lib/core.mjs";

// In-memory stand-in for Netlify Blobs (same method names and behaviour we rely on).
function memoryStore() {
  const m = new Map();
  return {
    async get(k, o) { const v = m.get(k); return v === undefined ? null : o?.type === "json" ? JSON.parse(v) : v; },
    async set(k, v, o) { if (o?.onlyIfNew && m.has(k)) return { modified: false }; m.set(k, v); return { modified: true, etag: "x" }; },
    async setJSON(k, v, o) { return this.set(k, JSON.stringify(v), o); },
    async delete(k) { m.delete(k); },
    async list({ prefix = "" } = {}) { return { blobs: [...m.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), directories: [] }; },
  };
}

const env = { ADMIN_USERNAME: "admin", ADMIN_PASSWORD: "pw123", SECRET_KEY: "k" };
let store, clock, token;
const T0 = Date.parse("2026-11-02T09:00:00Z");

async function call(method, path, body, { auth = true, now = clock } = {}) {
  const headers = { "content-type": "application/json" };
  if (auth && token) headers.authorization = "Bearer " + token;
  const res = await handle(new Request("https://x.test" + path, { method, headers, body: body ? JSON.stringify(body) : undefined }),
                           { store, env, now });
  return { status: res.status, data: await res.json() };
}

async function setup() {
  store = memoryStore(); clock = T0; token = "";
  token = (await call("POST", "/api/login", { username: "admin", password: "pw123" }, { auth: false })).data.token;
  const course = (await call("POST", "/api/admin/courses", { code: "ef101", name: "Intro" })).data;
  await call("POST", `/api/admin/courses/${course.id}/students`, { bulk: "ID, Name\n1, Ali Khan\n2; Sara Noor\n3 Bilal Ahmed\n1, Duplicate" });
  const s = (await call("POST", "/api/admin/sessions", { courseId: course.id, title: "L1", date: "2026-11-02", start: "09:00", end: "10:00", window: 15 })).data;
  return { course, s };
}

test("login: wrong password rejected, admin routes need a token", async () => {
  store = memoryStore(); token = "";
  assert.equal((await call("POST", "/api/login", { username: "admin", password: "no" }, { auth: false })).status, 401);
  assert.equal((await call("GET", "/api/admin/courses", null, { auth: false })).status, 401);
  assert.equal((await call("GET", "/api/admin/courses", null)).status, 401);
});

test("token expires after 12 hours", async () => {
  await setup();
  assert.equal((await call("GET", "/api/admin/courses", null, { now: T0 + 11 * 3600e3 })).status, 200);
  assert.equal((await call("GET", "/api/admin/courses", null, { now: T0 + 13 * 3600e3 })).status, 401);
});

test("class list: bulk import skips header and duplicates; manual add rejects duplicates", async () => {
  const { course } = await setup();
  const d = (await call("GET", `/api/admin/courses/${course.id}`)).data;
  assert.deepEqual(d.students.map((s) => s.roll), ["1", "2", "3"]);
  assert.equal((await call("POST", `/api/admin/courses/${course.id}/students`, { roll: "3", name: "x" })).status, 409);
  assert.equal((await call("POST", `/api/admin/courses/${course.id}/students`, { roll: "4", name: "Dua" })).status, 200);
  assert.equal((await call("POST", "/api/admin/courses", { code: "EF101", name: "again" })).status, 409);
});

test("student flow: unknown id, success, duplicate, same-phone block, other phone", async () => {
  const { s } = await setup();
  const url = `/api/public/sessions/${s.id}`;
  const info = await call("GET", url, null, { auth: false });
  assert.equal(info.data.isOpen, true);
  assert.equal(info.data.courseCode, "EF101");
  assert.equal((await call("POST", url + "/attend", { roll: "999", device: "phone-aaaa1" }, { auth: false })).status, 404);
  const ok = await call("POST", url + "/attend", { roll: " 1 ", device: "phone-aaaa1" }, { auth: false });
  assert.equal(ok.data.status, "ok"); assert.equal(ok.data.name, "Ali Khan");
  assert.equal((await call("POST", url + "/attend", { roll: "1", device: "phone-aaaa1" }, { auth: false })).data.status, "already");
  const friend = await call("POST", url + "/attend", { roll: "2", device: "phone-aaaa1" }, { auth: false });
  assert.equal(friend.status, 403);
  assert.equal((await call("POST", url + "/attend", { roll: "2", device: "phone-bbbb2" }, { auth: false })).data.status, "ok");
  const d = (await call("GET", `/api/admin/sessions/${s.id}`)).data;
  assert.equal(d.present, 2); assert.equal(d.total, 3);
  assert.equal(d.roster.find((r) => r.roll === "3").at, null);
});

test("20 simultaneous submissions for one student create exactly one record", async () => {
  const { s } = await setup();
  const url = `/api/public/sessions/${s.id}/attend`;
  const results = await Promise.all(Array.from({ length: 20 }, () => call("POST", url, { roll: "1" }, { auth: false })));
  assert.equal(results.filter((r) => r.data.status === "ok").length, 1);
  assert.equal(results.filter((r) => r.data.status === "already").length, 19);
  assert.equal((await call("GET", `/api/admin/sessions/${s.id}`)).data.present, 1);
});

test("time window: closed after expiry, reopen and close-now work", async () => {
  const { s } = await setup();
  const url = `/api/public/sessions/${s.id}/attend`;
  clock = T0 + 16 * 60e3;
  assert.equal((await call("POST", url, { roll: "1" }, { auth: false })).status, 409);
  await call("POST", `/api/admin/sessions/${s.id}/open`, { minutes: 5 });
  assert.equal((await call("POST", url, { roll: "1" }, { auth: false })).data.status, "ok");
  await call("POST", `/api/admin/sessions/${s.id}/close`, {});
  assert.equal((await call("POST", url, { roll: "2" }, { auth: false })).status, 409);
});

test("instructor confirmation toggles a student", async () => {
  const { s } = await setup();
  const p = `/api/admin/sessions/${s.id}/manual`;
  assert.equal((await call("POST", p, { roll: "3" })).data.status, "added");
  const d = (await call("GET", `/api/admin/sessions/${s.id}`)).data;
  assert.equal(d.roster.find((r) => r.roll === "3").source, "manual");
  assert.equal((await call("POST", p, { roll: "3" })).data.status, "removed");
});

test("reports: percentages, class stats, date and session filters, records export", async () => {
  const { course, s } = await setup();
  const s2 = (await call("POST", "/api/admin/sessions", { courseId: course.id, title: "L2", date: "2026-11-09", start: "09:00", end: "10:00" })).data;
  await call("POST", `/api/public/sessions/${s.id}/attend`, { roll: "1" }, { auth: false });
  await call("POST", `/api/public/sessions/${s.id}/attend`, { roll: "2" }, { auth: false });
  await call("POST", `/api/public/sessions/${s2.id}/attend`, { roll: "1" }, { auth: false });

  const r = (await call("GET", `/api/admin/reports?course=${course.id}&records=1`)).data;
  assert.equal(r.totalSessions, 2); assert.equal(r.totalStudents, 3);
  const by = Object.fromEntries(r.students.map((x) => [x.roll, x]));
  assert.equal(by["1"].pct, 100); assert.equal(by["2"].pct, 50); assert.equal(by["3"].pct, 0);
  assert.equal(r.overall, 50);           // 3 marks of 6 possible
  assert.equal(r.low, 2);                // students 2 and 3 are under 75%
  assert.deepEqual(r.sessions.map((x) => [x.present, x.absent, x.pct]), [[2, 1, 66.7], [1, 2, 33.3]]);
  assert.equal(r.records.length, 6);
  assert.equal(r.records.filter((x) => x.status === "Present").length, 3);

  const f = (await call("GET", `/api/admin/reports?course=${course.id}&from=2026-11-05`)).data;
  assert.equal(f.totalSessions, 1); assert.equal(f.sessions[0].title, "L2");
  const one = (await call("GET", `/api/admin/reports?course=${course.id}&session=${s.id}`)).data;
  assert.equal(one.totalSessions, 1); assert.equal(one.students.find((x) => x.roll === "2").pct, 100);
});

test("deleting a student, a session and a course cleans up records", async () => {
  const { course, s } = await setup();
  await call("POST", `/api/public/sessions/${s.id}/attend`, { roll: "1" }, { auth: false });
  await call("DELETE", `/api/admin/courses/${course.id}/students/1`);
  assert.equal((await call("GET", `/api/admin/sessions/${s.id}`)).data.present, 0);
  await call("POST", `/api/public/sessions/${s.id}/attend`, { roll: "2" }, { auth: false });
  await call("DELETE", `/api/admin/sessions/${s.id}`);
  assert.equal((await call("GET", "/api/admin/sessions")).data.length, 0);
  assert.equal([...(await store.list({ prefix: "att/" })).blobs].length, 0);
  assert.equal((await call("DELETE", `/api/admin/courses/${course.id}`)).status, 200);
  assert.equal((await call("GET", "/api/admin/courses")).data.length, 0);
});

test("dashboard summary and bad input", async () => {
  const { s } = await setup();
  await call("POST", `/api/public/sessions/${s.id}/attend`, { roll: "1" }, { auth: false });
  const d = (await call("GET", "/api/admin/summary")).data;
  assert.deepEqual(d.stats, { courses: 1, students: 3, sessions: 1, records: 1 });
  assert.equal(d.recent[0].present, 1);
  assert.equal((await call("POST", "/api/admin/sessions", { courseId: d.courses[0].id, date: "bad", start: "09:00", end: "10:00" })).status, 400);
  assert.equal((await call("GET", "/api/public/sessions/nope", null, { auth: false })).status, 404);
  assert.equal((await call("GET", "/api/nothing", null)).status, 404);
});
