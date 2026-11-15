# EF101-P10 QR Attendance System (v2)
Node.js + Express (API) · SQLite via built-in `node:sqlite` (`data.db`, created automatically) · plain HTML/CSS/JS.

## Run
    npm install
    npm start          (PowerShell blocked? use npm.cmd)
Open http://localhost:3000. Teacher password: `admin123` (change: set `ADMIN_PASS`).
Phones must be on the same Wi-Fi. If QR links show the wrong IP: set `BASE_URL=http://<laptop-ip>:3000` before `npm start`, and allow port 3000 in the firewall.

## Use
1. Teacher → Manage classes → create `EE-101 Basics of Electrical Engineering` with day/time/room.
2. Add students (`EE-26001, Name`). Roll format `EE-26XXX` is enforced and rolls are unique. A PIN is generated per student (shown once, download/print it).
3. Attendance sessions → Create → **Show QR on projector** (full-screen, rotates every 20 s, live counter).
4. Students log in (roll + PIN) and scan with their phone camera, or use Scan QR in the app (needs HTTPS).
5. Reports: date filter, trend chart, per-session and per-student %, student history, CSV export (opens in Excel). Proxy alerts tab lists blocked attempts.

## Personalization and offline game
- Use **Dark theme** / **Light theme** on each page to switch appearance. The selection is saved in this browser; the first visit follows the device theme.
- Student class cards show the current streak of consecutive attended sessions for that class. A late attendance counts; an unmarked session breaks the streak. Sessions still in progress are not counted yet.
- The app caches its pages for offline use and opens a small jumping game when a page cannot load because the connection is unavailable. Attendance and login still require a connection. Service workers work on `localhost` or HTTPS; plain HTTP on a phone's Wi-Fi IP does not support offline caching.

## Proxy (false attendance) defences
- **A. Student login:** attendance is saved against the logged-in account, so typing a friend's roll number does nothing. PINs are salted + hashed (scrypt); 5 wrong tries locks that roll for 5 minutes.
- **B. Rotating QR:** the QR holds `sessionId.code`, where `code = HMAC(secret, time-window)`. Windows are 20 s; a code works for its window plus the previous one (max 40 s), so a forwarded screenshot expires quickly.
- **C. Device lock:** the server gives each phone a `did` cookie. One phone cannot mark two different students in the same session. The second attempt is blocked and logged under Proxy alerts.
- Also: duplicate prevention (`UNIQUE(session_id, student_id)`), late status after 10 min, teacher can close a session or mark/undo manually.

## Required understanding
- **QR content:** URL `http://<server>:3000/a/<sessionId>.<rotating-code>`. No personal data.
- **Device → app:** phone camera opens the URL over the LAN; the server checks the student's login cookie, then `scan.html` calls `POST /api/s/attend`.
- **Storage:** row in `attendance(session_id, student_id, timestamp, status, device_id)`.
- **Duplicates:** database unique constraint + friendly message.
- **Limitations (be honest in the report):** clearing cookies/incognito resets the device lock; a student can share their PIN or a live photo of the QR inside 40 s; no GPS (needs HTTPS); HTTP only; one shared teacher password; prototype, not production.

## Tables
courses · students(pin_hash) · enrollments · sessions(secret, closed) · attendance(status, method, device_id) · flags
