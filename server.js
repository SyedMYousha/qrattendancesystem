// QR Attendance v2 – Express + built-in SQLite. Run: npm install && npm start
const express = require('express'), { DatabaseSync } = require('node:sqlite'), QRCode = require('qrcode');
const crypto = require('crypto'), path = require('path'), os = require('os');
const PORT = process.env.PORT || 3000, TEACHER_PASS = process.env.ADMIN_PASS || 'admin123';
const WIN = 20000, LATE_MIN = 10, ROLL = /^EE-26\d{3}$/;           // QR rotates every 20 s; late after 10 min
const BASE_URL = process.env.BASE_URL?.replace(/\/$/, '') || null;
const getLanAddresses = () => Object.values(os.networkInterfaces()).flat()
  .filter(a => a && !a.internal && a.family === 'IPv4')
  .map(a => `http://${a.address}:${PORT}`);
const qrBaseUrl = req => {
  if (BASE_URL) return BASE_URL;
  const host = String(req.headers['x-forwarded-host'] || req.get('host') || '').split(',')[0].trim();
  const protocol = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  return host ? `${protocol}://${host}` : `http://localhost:${PORT}`;
};

const db = new DatabaseSync(path.join(__dirname, 'data.db'));
db.exec(`PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS courses(id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, day TEXT, start_time TEXT, end_time TEXT, room TEXT);
CREATE TABLE IF NOT EXISTS students(id INTEGER PRIMARY KEY, roll TEXT UNIQUE NOT NULL, name TEXT NOT NULL, pin_hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS enrollments(course_id INTEGER NOT NULL REFERENCES courses(id), student_id INTEGER NOT NULL REFERENCES students(id), PRIMARY KEY(course_id, student_id));
CREATE TABLE IF NOT EXISTS sessions(id INTEGER PRIMARY KEY, course_id INTEGER NOT NULL REFERENCES courses(id), date TEXT NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL, secret TEXT NOT NULL, closed INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS attendance(id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL REFERENCES sessions(id), student_id INTEGER NOT NULL REFERENCES students(id), timestamp TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Present', method TEXT NOT NULL DEFAULT 'qr', device_id TEXT, UNIQUE(session_id, student_id));
CREATE TABLE IF NOT EXISTS flags(id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL REFERENCES sessions(id), student_id INTEGER NOT NULL, other_student_id INTEGER, reason TEXT NOT NULL, device_id TEXT, timestamp TEXT NOT NULL);`);
const all = (s, ...a) => db.prepare(s).all(...a), one = (s, ...a) => db.prepare(s).get(...a), run = (s, ...a) => db.prepare(s).run(...a);
const now = () => new Date().toISOString(), today = () => new Date().toLocaleDateString('en-CA');
const pct = (p, t) => t ? +(p * 100 / t).toFixed(1) : 0;

// ---------- helpers ----------
const hash = (pin, salt = crypto.randomBytes(8).toString('hex')) => salt + ':' + crypto.scryptSync(pin, salt, 32).toString('hex');
const check = (pin, h) => { const a = Buffer.from(hash(pin, h.split(':')[0])), b = Buffer.from(h); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const newPin = () => String(crypto.randomInt(1000, 10000));
const cookie = (req, k) => (req.headers.cookie || '').split(';').map(c => c.trim().split('=')).find(([n]) => n === k)?.[1];
const wrap = fn => async (req, res) => { try { await fn(req, res); } catch (e) { res.status(400).json({ error: /UNIQUE/.test(e.message) ? 'Already exists' : e.message }); } };
const S = new Map(), tries = new Map();                           // login sessions, failed-login log
const me = req => S.get(cookie(req, 'sid'));
const need = role => (req, res, next) => { const m = me(req); if (!m || m.role !== role) return res.status(401).json({ error: 'Please sign in' }); req.me = m; next(); };
const code = (secret, w) => crypto.createHmac('sha256', secret).update(String(w)).digest('base64url').slice(0, 8);
const win = () => Math.floor(Date.now() / WIN);
const codeOk = (s, c) => c === code(s.secret, win()) || c === code(s.secret, win() - 1);   // current or previous 20 s window

const app = express();
app.use(express.json());

// ---------- auth ----------
app.post('/api/login', wrap((req, res) => {
  const { role, password, roll, pin } = req.body, sid = crypto.randomBytes(16).toString('hex'), ck = [];
  if (role === 'teacher') {
    if (password !== TEACHER_PASS) return res.status(401).json({ error: 'Wrong password' });
    S.set(sid, { role: 'teacher' });
  } else {
    const key = String(roll || '').trim().toUpperCase(), log = (tries.get(key) || []).filter(t => Date.now() - t < 300000);
    tries.set(key, log);
    if (log.length >= 5) return res.status(429).json({ error: 'Too many wrong attempts. Wait 5 minutes.' });
    const st = one('SELECT * FROM students WHERE roll = ?', key);
    if (!st || !check(String(pin || ''), st.pin_hash)) { log.push(Date.now()); return res.status(401).json({ error: 'Wrong roll number or PIN' }); }
    S.set(sid, { role: 'student', id: st.id });
    if (!cookie(req, 'did')) ck.push(`did=${crypto.randomBytes(12).toString('hex')}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000`);
  }
  ck.push(`sid=${sid}; HttpOnly; SameSite=Lax; Path=/`);          // Lax so the cookie survives opening a scanned link
  res.setHeader('Set-Cookie', ck); res.json({ role });
}));
app.get('/api/me', (req, res) => {
  const m = me(req); if (!m) return res.status(401).json({ error: 'Not signed in' });
  res.json({ role: m.role, ...(m.role === 'student' ? one('SELECT roll, name FROM students WHERE id = ?', m.id) : {}) });
});
app.post('/api/logout', (req, res) => { S.delete(cookie(req, 'sid')); res.json({ ok: true }); });

// ---------- teacher ----------
const T = express.Router(); app.use('/api/t', need('teacher'), T);
const cv = b => [String(b.code || '').trim().toUpperCase(), String(b.name || '').trim(), b.day || '', b.start_time || '', b.end_time || '', b.room || ''];
T.get('/courses', (req, res) => res.json(all(`SELECT c.*, (SELECT COUNT(*) FROM enrollments WHERE course_id = c.id) students, (SELECT COUNT(*) FROM sessions WHERE course_id = c.id) sessions FROM courses c ORDER BY code`)));
T.post('/courses', wrap((req, res) => { const v = cv(req.body); if (!v[0] || !v[1]) throw new Error('Class code and name are required'); res.json({ id: run('INSERT INTO courses(code,name,day,start_time,end_time,room) VALUES(?,?,?,?,?,?)', ...v).lastInsertRowid }); }));
T.put('/courses/:id', wrap((req, res) => { const v = cv(req.body); if (!v[0] || !v[1]) throw new Error('Class code and name are required'); run('UPDATE courses SET code=?,name=?,day=?,start_time=?,end_time=?,room=? WHERE id=?', ...v, req.params.id); res.json({ ok: true }); }));
T.delete('/courses/:id', wrap((req, res) => {
  for (const q of ['DELETE FROM attendance WHERE session_id IN (SELECT id FROM sessions WHERE course_id=?)', 'DELETE FROM flags WHERE session_id IN (SELECT id FROM sessions WHERE course_id=?)', 'DELETE FROM sessions WHERE course_id=?', 'DELETE FROM enrollments WHERE course_id=?', 'DELETE FROM courses WHERE id=?']) run(q, req.params.id);
  res.json({ ok: true });
}));

T.get('/courses/:id/students', (req, res) => res.json(all('SELECT st.roll, st.name FROM students st JOIN enrollments e ON e.student_id = st.id WHERE e.course_id = ? ORDER BY st.roll', req.params.id)));
T.post('/courses/:id/students', wrap((req, res) => {            // lines: "EE-26001, Name"
  const added = [], errors = [];
  for (const line of String(req.body.text || '').split('\n')) {
    if (!line.trim()) continue;
    const [r, ...n] = line.split(','), roll = r.trim().toUpperCase(), name = n.join(',').trim();
    if (!ROLL.test(roll)) { errors.push(`${line.trim()} – roll number must look like EE-26123`); continue; }
    if (!name) { errors.push(`${roll} – name missing`); continue; }
    let st = one('SELECT * FROM students WHERE roll = ?', roll), pin = null;
    if (!st) { pin = newPin(); run('INSERT INTO students(roll,name,pin_hash) VALUES(?,?,?)', roll, name, hash(pin)); }
    else if (st.name.toLowerCase() !== name.toLowerCase()) { errors.push(`${roll} – already belongs to "${st.name}". Roll numbers must be unique.`); continue; }
    st = one('SELECT * FROM students WHERE roll = ?', roll);
    if (run('INSERT OR IGNORE INTO enrollments VALUES(?,?)', req.params.id, st.id).changes) added.push({ roll, name, pin }); else errors.push(`${roll} – already in this class`);
  }
  res.json({ added, errors });
}));
T.delete('/courses/:id/students/:roll', wrap((req, res) => { run('DELETE FROM enrollments WHERE course_id=? AND student_id=(SELECT id FROM students WHERE roll=?)', req.params.id, req.params.roll); res.json({ ok: true }); }));
T.put('/students/:roll', wrap((req, res) => { if (!String(req.body.name || '').trim()) throw new Error('Name required'); run('UPDATE students SET name=? WHERE roll=?', req.body.name.trim(), req.params.roll); res.json({ ok: true }); }));
T.post('/students/:roll/pin', wrap((req, res) => { const pin = newPin(); if (!run('UPDATE students SET pin_hash=? WHERE roll=?', hash(pin), req.params.roll).changes) throw new Error('Student not found'); res.json({ pin }); }));

T.post('/sessions', wrap((req, res) => {
  const b = req.body, c = one('SELECT * FROM courses WHERE id = ?', b.course_id); if (!c) throw new Error('Choose a class first');
  const date = b.date || today(), st = b.start_time || c.start_time, en = b.end_time || c.end_time;
  if (!st || !en) throw new Error('Start and end time required');
  res.json({ id: run('INSERT INTO sessions(course_id,date,start_time,end_time,secret,created_at) VALUES(?,?,?,?,?,?)', c.id, date, st, en, crypto.randomBytes(16).toString('hex'), now()).lastInsertRowid });
}));
T.get('/sessions', (req, res) => res.json(all(`SELECT s.id, s.date, s.start_time, s.end_time, s.closed,
  (SELECT COUNT(*) FROM attendance a JOIN enrollments e ON e.student_id = a.student_id AND e.course_id = s.course_id WHERE a.session_id = s.id) present,
  (SELECT COUNT(*) FROM enrollments WHERE course_id = s.course_id) total
  FROM sessions s WHERE s.course_id = ? AND s.date BETWEEN ? AND ? ORDER BY s.date DESC, s.start_time DESC`, req.query.course_id, req.query.from || '0000-00-00', req.query.to || '9999-99-99')));
const flagSql = `SELECT f.timestamp, s.date, s.start_time, a.roll, a.name, b.roll broll, b.name bname, f.reason FROM flags f JOIN sessions s ON s.id = f.session_id JOIN students a ON a.id = f.student_id LEFT JOIN students b ON b.id = f.other_student_id`;
T.get('/sessions/:id', wrap((req, res) => {
  const s = one('SELECT s.id, s.course_id, s.date, s.start_time, s.end_time, s.closed, c.code, c.name course FROM sessions s JOIN courses c ON c.id = s.course_id WHERE s.id = ?', req.params.id);
  if (!s) return res.status(404).json({ error: 'Session not found' });
  const rows = all(`SELECT st.roll, st.name, a.timestamp, a.method, CASE WHEN a.id IS NULL THEN 'Absent' ELSE a.status END status FROM enrollments e JOIN students st ON st.id = e.student_id LEFT JOIN attendance a ON a.session_id = ? AND a.student_id = st.id WHERE e.course_id = ? ORDER BY st.roll`, s.id, s.course_id);
  const present = rows.filter(r => r.status !== 'Absent').length;
  res.json({ ...s, rows, flags: all(flagSql + ' WHERE f.session_id = ? ORDER BY f.id DESC', s.id), stats: { present, absent: rows.length - present, total: rows.length, pct: pct(present, rows.length) } });
}));
T.post('/sessions/:id/closed', wrap((req, res) => { run('UPDATE sessions SET closed=? WHERE id=?', req.body.closed ? 1 : 0, req.params.id); res.json({ ok: true }); }));
T.post('/sessions/:id/mark', wrap((req, res) => {
  const s = one('SELECT course_id FROM sessions WHERE id=?', req.params.id);
  const st = one('SELECT st.id FROM students st JOIN enrollments e ON e.student_id = st.id WHERE e.course_id = ? AND st.roll = ?', s.course_id, String(req.body.roll || '').trim().toUpperCase());
  if (!st) throw new Error('That roll number is not in this class');
  run(`INSERT OR IGNORE INTO attendance(session_id,student_id,timestamp,status,method) VALUES(?,?,?,'Present','manual')`, req.params.id, st.id, now()); res.json({ ok: true });
}));
T.delete('/sessions/:id/mark/:roll', wrap((req, res) => { run('DELETE FROM attendance WHERE session_id=? AND student_id=(SELECT id FROM students WHERE roll=?)', req.params.id, req.params.roll); res.json({ ok: true }); }));

const qrCache = new Map();                                       // projector: live rotating QR + counter
T.get('/sessions/:id/live', wrap(async (req, res) => {
  const s = one('SELECT s.*, c.code ccode, c.name cname FROM sessions s JOIN courses c ON c.id = s.course_id WHERE s.id = ?', req.params.id);
  if (!s) return res.status(404).json({ error: 'Session not found' });
  const w = win(), key = `${s.id}-${w}`;
  const baseUrl = qrBaseUrl(req);
  const qrKey = `${baseUrl}-${key}`;
  if (!qrCache.has(qrKey)) { if (qrCache.size > 30) qrCache.clear(); qrCache.set(qrKey, await QRCode.toDataURL(`${baseUrl}/a/${s.id}.${code(s.secret, w)}`, { width: 520, margin: 2 })); }
  const recent = all(`SELECT st.name, st.roll, a.timestamp, a.status FROM attendance a JOIN students st ON st.id = a.student_id WHERE a.session_id = ? ORDER BY a.id DESC LIMIT 6`, s.id);
  const present = one('SELECT COUNT(*) n FROM attendance a JOIN enrollments e ON e.student_id = a.student_id AND e.course_id = ? WHERE a.session_id = ?', s.course_id, s.id).n;
  res.json({ qr: qrCache.get(qrKey), left: (w + 1) * WIN - Date.now(), win: WIN, closed: !!s.closed, code: s.ccode, name: s.cname, date: s.date, start: s.start_time, end: s.end_time, present, total: one('SELECT COUNT(*) n FROM enrollments WHERE course_id=?', s.course_id).n, recent });
}));

T.get('/flags', (req, res) => res.json(all(flagSql + ' WHERE s.course_id = ? ORDER BY f.id DESC', req.query.course_id)));
const history = (cid, sid) => all(`SELECT s.date, s.start_time, CASE WHEN a.id IS NULL THEN 'Absent' ELSE a.status END status, a.timestamp FROM sessions s LEFT JOIN attendance a ON a.session_id = s.id AND a.student_id = ? WHERE s.course_id = ? ORDER BY s.date DESC, s.start_time DESC`, sid, cid);
T.get('/history', wrap((req, res) => res.json(history(req.query.course_id, one('SELECT id FROM students WHERE roll=?', req.query.roll)?.id))));

function report(q) {
  const cid = q.course_id, from = q.from || '0000-00-00', to = q.to || '9999-99-99';
  const sessions = all('SELECT id,date,start_time FROM sessions WHERE course_id=? AND date BETWEEN ? AND ? ORDER BY date,start_time', cid, from, to);
  const students = all('SELECT st.id, st.roll, st.name FROM students st JOIN enrollments e ON e.student_id = st.id WHERE e.course_id = ? ORDER BY st.roll', cid);
  const att = new Map(all(`SELECT a.session_id || '-' || a.student_id k, a.status FROM attendance a JOIN sessions s ON s.id = a.session_id WHERE s.course_id = ? AND s.date BETWEEN ? AND ?`, cid, from, to).map(r => [r.k, r.status]));
  return {
    sessions: sessions.map(s => { const present = students.filter(st => att.has(`${s.id}-${st.id}`)).length; return { ...s, present, absent: students.length - present, total: students.length, pct: pct(present, students.length) }; }),
    students: students.map(st => { const marks = sessions.map(s => { const a = att.get(`${s.id}-${st.id}`); return a === 'Late' ? 'L' : a ? 'P' : 'A'; }), present = marks.filter(m => m !== 'A').length; return { roll: st.roll, name: st.name, present, total: sessions.length, pct: pct(present, sessions.length), marks }; })
  };
}
T.get('/report', wrap((req, res) => res.json(report(req.query))));
T.get('/export', wrap((req, res) => {                              // CSV – opens in Excel
  const r = report(req.query), q = v => `"${String(v).replace(/"/g, '""')}"`;
  const lines = [['Roll', 'Name', ...r.sessions.map(s => `${s.date} ${s.start_time}`), 'Present', 'Sessions', 'Percent'], ...r.students.map(s => [s.roll, s.name, ...s.marks, s.present, s.total, s.pct])];
  res.setHeader('Content-Type', 'text/csv'); res.setHeader('Content-Disposition', 'attachment; filename="attendance.csv"');
  res.send('\ufeff' + lines.map(l => l.map(q).join(',')).join('\r\n'));
}));

// ---------- student ----------
const SR = express.Router(); app.use('/api/s', need('student'), SR);
SR.get('/classes', (req, res) => res.json(all('SELECT c.* FROM courses c JOIN enrollments e ON e.course_id = c.id WHERE e.student_id = ? ORDER BY c.code', req.me.id).map(c => {
  const total = one('SELECT COUNT(*) n FROM sessions WHERE course_id=?', c.id).n;
  const present = one('SELECT COUNT(*) n FROM attendance a JOIN sessions s ON s.id = a.session_id WHERE s.course_id = ? AND a.student_id = ?', c.id, req.me.id).n;
  const p = pct(present, total), low = total > 0 && p < 75;
  const date = today(), time = new Date().toTimeString().slice(0, 5);
  const recent = all(`SELECT a.id attended FROM sessions s LEFT JOIN attendance a ON a.session_id=s.id AND a.student_id=?
    WHERE s.course_id=? AND (s.date < ? OR (s.date=? AND s.end_time <= ?))
    ORDER BY s.date DESC,s.start_time DESC`, req.me.id, c.id, date, date, time);
  let streak = 0;
  for (const session of recent) { if (!session.attended) break; streak++; }
  return { ...c, total, present, streak, pct: total ? p : null, low, canMiss: total && !low ? Math.max(0, Math.floor(present / 0.75 - total)) : null, mustAttend: low ? Math.ceil(3 * total - 4 * present) : 0, open: !!one('SELECT 1 x FROM sessions WHERE course_id=? AND closed=0 AND date=?', c.id, today()) };
})));
SR.get('/classes/:id/history', (req, res) => res.json(history(req.params.id, req.me.id)));
SR.post('/pin', wrap((req, res) => {
  const st = one('SELECT * FROM students WHERE id=?', req.me.id), np = String(req.body.new || '');
  if (!check(String(req.body.old || ''), st.pin_hash)) throw new Error('Current PIN is wrong');
  if (!/^\d{4,8}$/.test(np)) throw new Error('New PIN must be 4–8 digits');
  run('UPDATE students SET pin_hash=? WHERE id=?', hash(np), st.id); res.json({ ok: true });
}));
SR.post('/attend', wrap((req, res) => {
  const [sid, c] = String(req.body.t || '').split('.'), s = one('SELECT s.*, c.code FROM sessions s JOIN courses c ON c.id = s.course_id WHERE s.id = ?', sid);
  if (!s || !codeOk(s, c)) return res.status(400).json({ error: 'This QR code has expired. Scan the live code on the screen again.' });
  if (s.closed) return res.status(403).json({ error: 'This session is closed.' });
  if (!one('SELECT 1 x FROM enrollments WHERE course_id=? AND student_id=?', s.course_id, req.me.id)) return res.status(403).json({ error: `You are not enrolled in ${s.code}.` });
  if (one('SELECT 1 x FROM attendance WHERE session_id=? AND student_id=?', s.id, req.me.id)) return res.status(409).json({ error: 'Your attendance is already marked for this session.' });
  const device = cookie(req, 'did'); if (!device) return res.status(400).json({ error: 'Log out and log in again.' });
  const other = one('SELECT student_id FROM attendance WHERE session_id=? AND device_id=? AND student_id != ?', s.id, device, req.me.id);
  if (other) {                                                    // device lock: one phone, one student per session
    run('INSERT INTO flags(session_id,student_id,other_student_id,reason,device_id,timestamp) VALUES(?,?,?,?,?,?)', s.id, req.me.id, other.student_id, 'Same phone used for two students', device, now());
    return res.status(403).json({ error: 'This phone has already marked attendance for another student. Your teacher has been notified.' });
  }
  const late = Date.now() > new Date(`${s.date}T${s.start_time}`).getTime() + LATE_MIN * 60000;
  run('INSERT INTO attendance(session_id,student_id,timestamp,status,method,device_id) VALUES(?,?,?,?,?,?)', s.id, req.me.id, now(), late ? 'Late' : 'Present', 'qr', device);
  res.json({ ok: true, status: late ? 'Late' : 'Present', message: `${s.code}: marked ${late ? 'late' : 'present'}.` });
}));

// ---------- pages ----------
app.get('/a/:t', (req, res) => { const m = me(req); if (m?.role === 'student') return res.sendFile(path.join(__dirname, 'public/scan.html')); res.redirect('/?next=' + encodeURIComponent(req.originalUrl)); });
app.use(express.static(path.join(__dirname, 'public')));
app.listen(PORT, '0.0.0.0', () => {
  const addresses = getLanAddresses();
  console.log(`Open: http://localhost:${PORT}${addresses.length ? `\nLAN: ${addresses.join(', ')}` : ''}\nQR links use the address in the browser, or BASE_URL when set.\nTeacher password: ${TEACHER_PASS}`);
});
