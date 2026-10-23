# QR-Based Student Attendance System (EF101-P10) - Netlify edition

The instructor opens an attendance session, a QR code appears, students scan it with their phones and type
their student ID. Records are stored and reported per session and per student.

**Stack:** plain HTML, CSS and JavaScript in the browser. One serverless function (Netlify Functions, Node.js)
is the API. Netlify Blobs is the storage. There is no server to run and no database to set up.

> Python note: Netlify cannot run a Python (Flask) server. This edition keeps the same features and screens as the
> Flask version, with the backend rewritten in JavaScript as a Netlify Function.

## Folder layout

```
netlify-qr-attendance/
  netlify.toml                   Netlify settings (publish folder, functions, /a/<id> link, headers)
  package.json                   one dependency: @netlify/blobs
  public/                        the website (this is what students and instructors open)
    index.html                   home page
    admin.html                   instructor app (sign in, courses, sessions, reports)
    attend.html                  page students see after scanning the QR code
    present.html                 full-screen QR for projecting in class
    404.html
    css/style.css
    js/api.js                    fetch wrapper + small helpers
    js/admin.js                  instructor app logic
    js/attend.js                 student page logic
    js/present.js                projector page logic
    js/vendor/qrcode.js          QR generator (MIT licence), bundled so no CDN is needed
  netlify/functions/
    api.mjs                      the function: every /api/* request lands here
    lib/core.mjs                 all API logic (login, sessions, check-in, reports)
  tests/core.test.mjs            automated tests of the API logic  (npm test)
  dev-server.mjs                 local preview without any Netlify tools (npm run local)
```

## Try it on your computer (no Netlify account needed)

```bash
npm install
npm run local          # opens http://localhost:8888  (sign in: admin / admin123)
npm test               # runs the 10 automated API tests
```

Local data is saved in `.local-data/db.json`. To try it with real phones on the same Wi-Fi, open the site using your
computer's address (for example `http://192.168.1.20:8888`) in the instructor's browser. The QR code uses whatever address
the instructor's browser is on.

## Deploy to Netlify

The API is a function, so deploy with **Git** or the **Netlify CLI**. Dragging only the `public` folder onto Netlify Drop
would publish the pages without the API.

**Option A - Git (recommended)**
1. Put this folder in a GitHub/GitLab repository.
2. In Netlify: *Add new site > Import an existing project*, pick the repository. Settings come from `netlify.toml`
   (publish `public`, functions `netlify/functions`). Click *Deploy*.
3. Open *Site configuration > Environment variables* and add the three variables below, then *Deploys > Trigger deploy*.

**Option B - Netlify CLI**
```bash
npm install
npx netlify login
npx netlify init            # or: npx netlify link
npx netlify env:set ADMIN_PASSWORD "choose-a-strong-password"
npx netlify env:set SECRET_KEY "$(openssl rand -hex 32)"
npx netlify deploy --prod
```
Use `npx netlify dev` to run the real Netlify runtime locally, including a sandboxed Blobs store.

### Environment variables (set these before real use)

| Name | Purpose | Default if missing |
|---|---|---|
| `ADMIN_USERNAME` | Instructor username | `admin` |
| `ADMIN_PASSWORD` | Instructor password | `admin123` (change it!) |
| `SECRET_KEY` | Signs login tokens. Use a long random value | derived from the password |

### After the first deploy: 2-minute check
1. Open `https://YOUR-SITE.netlify.app/admin.html` and sign in.
2. Add a course and two students, then create a session.
3. Open the QR link on your phone (or scan the QR). Enter a student ID. The session page should show the student as Present within 5 seconds.

HTTPS is on by default on Netlify, which phones need for a smooth scan-and-open experience.

## Using it

1. **Courses & students** - add a course, then add students (ID + name) one by one, or paste/upload `ID, Name` lines.
2. **Dashboard** - choose course, date and class time, then *Create session and show QR*.
3. Click **Show full screen for the class** to project the QR. Students scan it, enter their ID and see a confirmation.
4. The session page updates live. Use **Mark present / Undo** for instructor confirmation, **Close now** to stop, **Reopen** to extend.
5. **Reports** - class statistics per session, attendance % per student, filters by course, date range or single session,
   and **CSV export** (opens directly in Excel).

## Requirements checklist

| Requirement | Where |
|---|---|
| Course/class record and student list (ID + name) | Courses & students page, stored in Blobs (`courses`, `roster/<course>`) |
| Instructor creates a session (course, date, class time) | Dashboard form |
| QR code representing/linking to the session | Generated in the browser, encodes `https://your-site/a/<secret-session-id>` |
| Student scans/opens QR and submits attendance | `/a/<id>` page (`attend.html`) |
| Record with student, session, timestamp | One Blobs entry per check-in: `att/<session>/<student>` with an ISO timestamp |
| Prevent duplicate submission | Entry is created with `onlyIfNew`, so only one request can ever create it (tested with 20 simultaneous taps) |
| Status per student for a session | Session page (Present / Absent) |
| Attendance % per student across sessions | Reports page |
| Class statistics: present, absent, % | Reports page (per session and overall) |
| Date / session filtering | Reports and Sessions pages |
| Export CSV/Excel | Reports page: summary and every record |
| Administrator view to create sessions and view records | `admin.html` |
| Bonus: time-limited QR | Each session accepts check-ins for N minutes; extend or close any time |
| Bonus: login | Instructor sign-in with a signed 12-hour token |
| Bonus: instructor confirmation | Mark present / Undo on the session page |
| Bonus: dashboard | Dashboard totals and live session counters |

## Required understanding (short answers)

**What is encoded in the QR code?** Only a web link: `https://your-site/a/<session-id>`. The id is a random 18-character string
unique to one session. The QR contains no student data and no result.

**How does the student's device reach the application?** The phone camera reads the QR and opens the link in the browser. Netlify
serves `attend.html` for any `/a/...` address, and the page loads the session details from `/api/public/sessions/<id>`.

**How does the submission reach storage?** The page posts the student ID to `/api/public/sessions/<id>/attend`. The function checks the
session is open and the ID is on that course's list, then writes one entry (student, session, timestamp, source) to Netlify Blobs.

**How are duplicates detected?** Each check-in is stored under a key made from the session and the student ID, written with
the "only if new" condition. A second write for the same key is refused by the storage itself, so duplicates are impossible even when
two taps arrive at the same moment. The student sees "already marked present".

**Limitations of a simple QR approach**
- The QR is just a link. A photo of it can be sent to an absent friend.
- Typing an ID is not proof of identity. A friend who knows your ID can mark you. The app blocks a second student ID from the
  same phone in one session (a random id kept in the browser), but another phone or cleared browser storage bypasses that.
- The time window shortens how long a shared QR is useful but does not prove the student is in the room.
- No location check, so someone can mark attendance from outside the class.
- Single shared instructor account, not a hardened production system. This is a learning prototype.

**Improvements (extension ideas):** a QR that changes every 30 seconds, a location restriction, per-student login with a one-time code,
dashboard charts, and offline synchronisation.

## Privacy

Only the student ID and name are stored, plus a random device id used to flag shared phones. Deleting a course removes all its students,
sessions and records.

## Notes

- Times shown are in the viewer's local time zone. New sessions default to the instructor's current date and time.
- The instructor's session page refreshes every 5 seconds while it is open. Close the tab when you are done.
- Back up by exporting CSV from the Reports page.
