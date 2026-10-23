/* Instructor app. One page, hash routes: #/dashboard #/courses #/courses/<id> #/sessions #/sessions/<id> #/reports */
(function () {
  "use strict";
  var app = document.getElementById("app");
  var loginView = document.getElementById("login-view");
  var shell = document.getElementById("shell");
  var timers = [];

  // ------------------------------------------------------------ small utilities
  function clearTimers() { timers.forEach(clearInterval); timers = []; }
  function every(ms, fn) { timers.push(setInterval(fn, ms)); }
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function flash(msg, kind) {
    var el = document.getElementById("flash");
    el.innerHTML = '<div class="flash ' + (kind || "ok") + '" role="status">' + esc(msg) + "</div>";
    clearTimeout(flash.t);
    flash.t = setTimeout(function () { el.innerHTML = ""; }, 6000);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function fail(err) { flash(err.message, "error"); }

  function today() { return new Date().toLocaleDateString("en-CA"); }
  function nowHM() { return new Date().toTimeString().slice(0, 5); }
  function openBadge(open) { return '<span class="badge ' + (open ? "open" : "closed") + '">' + (open ? "Open" : "Closed") + "</span>"; }
  function formData(form) {
    var o = {};
    $$("input, select, textarea", form).forEach(function (el) { if (el.name) o[el.name] = el.value; });
    return o;
  }
  function onSubmit(form, fn) {
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      fn(formData(form), form);
    });
  }
  function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }

  function toCsv(rows) {
    return "\ufeff" + rows.map(function (r) {
      return r.map(function (v) {
        v = String(v == null ? "" : v);
        return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
      }).join(",");
    }).join("\r\n");
  }
  function download(name, text) {
    var a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1500);
  }

  // ------------------------------------------------------------ login / logout
  function showLogin() { shell.hidden = true; loginView.hidden = false; $("#username").focus(); }
  function showShell() { loginView.hidden = true; shell.hidden = false; }

  onSubmit($("#login-form"), function (d) {
    API.post("/login", { username: d.username, password: d.password })
      .then(function (r) { API.setToken(r.token); $("#login-error").innerHTML = ""; $("#password").value = ""; route(); })
      .catch(function (err) { $("#login-error").innerHTML = '<div class="flash error" role="alert">' + esc(err.message) + "</div>"; });
  });
  $("#logout").addEventListener("click", function (e) { e.preventDefault(); API.setToken(""); clearTimers(); showLogin(); });
  window.addEventListener("qa-signed-out", function () { clearTimers(); showLogin(); });

  // ------------------------------------------------------------ router
  function route() {
    clearTimers();
    if (!API.token()) { showLogin(); return; }
    showShell();
    var raw = (location.hash.slice(1) || "/dashboard").split("?");
    var parts = raw[0].split("/").filter(Boolean);
    var params = new URLSearchParams(raw[1] || "");
    $$("[data-nav]").forEach(function (a) { a.classList.toggle("active", a.dataset.nav === parts[0]); });
    app.innerHTML = '<p class="loading">Loading...</p>';
    var view;
    if (parts[0] === "courses") view = parts[1] ? viewCourse(parts[1]) : viewCourses();
    else if (parts[0] === "sessions") view = parts[1] ? viewSession(parts[1]) : viewSessions(params);
    else if (parts[0] === "reports") view = viewReports(params);
    else view = viewDashboard();
    view.catch(function (err) {
      if (err.status === 401) return;
      app.innerHTML = '<div class="card empty">' + esc(err.message) + "</div>";
    });
  }
  window.addEventListener("hashchange", route);

  // ------------------------------------------------------------ dashboard
  function sessionRowsTable(rows) {
    return '<div class="table-wrap"><table><thead><tr><th>Date</th><th>Session</th><th>Class time</th><th class="num">Present</th><th class="num">Absent</th><th>State</th></tr></thead><tbody>' +
      rows.map(function (s) {
        return "<tr><td>" + esc(s.date) + '</td><td><a href="#/sessions/' + esc(s.id) + '">' + esc(s.title) + '</a><br><span class="muted small">' + esc(s.courseCode) + "</span></td>" +
          "<td>" + esc(s.start) + "-" + esc(s.end) + '</td><td class="num">' + s.present + '</td><td class="num">' + (s.total - s.present) + "</td><td>" + openBadge(s.isOpen) + "</td></tr>";
      }).join("") + "</tbody></table></div>";
  }

  function viewDashboard() {
    return API.get("/admin/summary").then(function (d) {
      var st = d.stats;
      var form = d.courses.length
        ? '<form id="new-session"><div class="field"><label for="course_id">Course</label><select id="course_id" name="courseId">' +
          d.courses.map(function (c) { return '<option value="' + esc(c.id) + '">' + esc(c.code) + " - " + esc(c.name) + "</option>"; }).join("") + "</select></div>" +
          '<div class="field"><label for="title">Session title <span class="muted">(optional)</span></label><input id="title" name="title" placeholder="Lecture 5 - Arrays"></div>' +
          '<div class="row"><div class="field"><label for="date">Date</label><input id="date" type="date" name="date" value="' + today() + '" required></div>' +
          '<div class="field"><label for="start">Class starts</label><input id="start" type="time" name="start" value="' + nowHM() + '" required></div>' +
          '<div class="field"><label for="end">Class ends</label><input id="end" type="time" name="end" value="' + nowHM() + '" required></div></div>' +
          '<div class="field"><label for="window">QR stays open for (minutes)</label><input id="window" type="number" name="window" min="1" max="600" value="15">' +
          '<span class="muted small">After this time, submissions are rejected. You can reopen it later.</span></div>' +
          '<button class="btn" type="submit">Create session and show QR</button></form>'
        : '<div class="empty">No course yet. <a href="#/courses">Add a course and its students</a> to begin.</div>';
      app.innerHTML =
        '<div class="page-head"><h1>Dashboard</h1></div>' +
        '<div class="stats"><div class="stat"><b>' + st.courses + "</b><span>Courses</span></div><div class=\"stat\"><b>" + st.students + "</b><span>Students</span></div>" +
        '<div class="stat"><b>' + st.sessions + '</b><span>Sessions held</span></div><div class="stat ok"><b>' + st.records + "</b><span>Attendance records</span></div></div>" +
        '<div class="grid two"><section class="card"><h2>Start a new attendance session</h2>' + form + "</section>" +
        '<section class="card"><h2>Recent sessions</h2>' +
        (d.recent.length ? sessionRowsTable(d.recent) + '<p style="margin-top:.75rem"><a href="#/sessions">See all sessions</a></p>'
                         : '<div class="empty">No sessions yet. Create your first one on the left.</div>') + "</section></div>";
      var f = $("#new-session");
      if (f) onSubmit(f, function (data) {
        API.post("/admin/sessions", data).then(function (s) { go("#/sessions/" + s.id); }).catch(fail);
      });
    });
  }

  // ------------------------------------------------------------ courses & students
  function viewCourses() {
    return API.get("/admin/courses").then(function (courses) {
      app.innerHTML =
        '<div class="page-head"><h1>Courses &amp; students</h1></div><div class="grid two">' +
        '<section class="card"><h2>Add a course</h2><form id="new-course"><div class="row">' +
        '<div class="field"><label for="code">Course code</label><input id="code" name="code" placeholder="EF101" required></div>' +
        '<div class="field" style="flex:2 1 200px"><label for="cname">Course name</label><input id="cname" name="name" placeholder="Introduction to Computing" required></div></div>' +
        '<button class="btn" type="submit">Add course</button></form></section>' +
        '<section class="card"><h2>Your courses</h2>' +
        (courses.length
          ? '<div class="table-wrap"><table><thead><tr><th>Course</th><th class="num">Students</th><th class="num">Sessions</th><th></th></tr></thead><tbody>' +
            courses.map(function (c) {
              return "<tr><td><b>" + esc(c.code) + '</b><br><span class="muted small">' + esc(c.name) + '</span></td><td class="num">' + c.students +
                '</td><td class="num">' + c.sessions + '</td><td><a class="btn sm ghost" href="#/courses/' + esc(c.id) + '">Manage students</a></td></tr>';
            }).join("") + "</tbody></table></div>"
          : '<div class="empty">No courses yet. Add one to start building a class list.</div>') + "</section></div>";
      onSubmit($("#new-course"), function (d) {
        API.post("/admin/courses", d).then(function (c) { flash("Course " + c.code + " added."); route(); }).catch(fail);
      });
    });
  }

  function viewCourse(id) {
    return API.get("/admin/courses/" + encodeURIComponent(id)).then(function (d) {
      var c = d.course;
      app.innerHTML =
        '<div class="page-head"><div><h1>' + esc(c.code) + " - " + esc(c.name) + '</h1><p class="muted">' + d.students.length + ' student(s) on the class list</p></div>' +
        '<button class="btn danger sm" id="del-course" type="button">Delete course</button></div><div class="grid two"><section class="card">' +
        '<h2>Add one student</h2><form id="add-student"><div class="row"><div class="field"><label for="roll">Student ID / roll number</label><input id="roll" name="roll" required></div>' +
        '<div class="field" style="flex:2 1 200px"><label for="sname">Full name</label><input id="sname" name="name" required></div></div><button class="btn" type="submit">Add student</button></form>' +
        '<hr style="border:0;border-top:1px solid var(--line);margin:1.25rem 0"><h2>Import a class list</h2>' +
        '<p class="muted small">One student per line as <code>ID, Name</code>. Upload a CSV file or paste the lines. IDs already on the list are skipped.</p>' +
        '<form id="import"><div class="field"><label for="bulk">Paste students</label><textarea id="bulk" name="bulk" placeholder="21F-001, Ayesha Khan&#10;21F-002, Bilal Ahmed"></textarea></div>' +
        '<div class="field"><label for="file">or upload CSV</label><input id="file" type="file" accept=".csv,.txt"></div><button class="btn" type="submit">Import students</button></form></section>' +
        '<section class="card"><h2>Class list</h2>' +
        (d.students.length
          ? '<div class="table-wrap"><table><thead><tr><th>Student ID</th><th>Name</th><th></th></tr></thead><tbody>' +
            d.students.map(function (s) {
              return "<tr><td>" + esc(s.roll) + "</td><td>" + esc(s.name) + '</td><td class="num"><button class="btn sm danger" type="button" data-remove="' + esc(s.roll) + '" data-name="' + esc(s.name) + '">Remove</button></td></tr>';
            }).join("") + "</tbody></table></div>"
          : '<div class="empty">No students yet. Add one or import a list.</div>') + "</section></div>";

      onSubmit($("#add-student"), function (data) {
        API.post("/admin/courses/" + id + "/students", data).then(function () { flash(data.name + " (" + data.roll + ") added."); route(); }).catch(fail);
      });
      onSubmit($("#import"), function (data, form) {
        var file = $("#file", form).files[0];
        var read = file ? file.text() : Promise.resolve(data.bulk);
        read.then(function (text) { return API.post("/admin/courses/" + id + "/students", { bulk: text }); })
          .then(function (r) { flash("Imported " + r.added + " student(s)" + (r.skipped ? ", skipped " + r.skipped + " duplicate ID(s)." : "."), r.added ? "ok" : "error"); route(); })
          .catch(fail);
      });
      $$("[data-remove]").forEach(function (b) {
        b.addEventListener("click", function () {
          if (!confirm("Remove " + b.dataset.name + "? Their attendance records are removed too.")) return;
          API.del("/admin/courses/" + id + "/students/" + encodeURIComponent(b.dataset.remove)).then(function () { flash(b.dataset.name + " removed."); route(); }).catch(fail);
        });
      });
      $("#del-course").addEventListener("click", function () {
        if (!confirm("Delete this course with all its students, sessions and attendance records?")) return;
        API.del("/admin/courses/" + id).then(function () { flash("Course deleted."); go("#/courses"); }).catch(fail);
      });
    });
  }

  // ------------------------------------------------------------ sessions list
  function viewSessions(p) {
    var f = { course: p.get("course") || "", from: p.get("from") || "", to: p.get("to") || "" };
    var q = "?" + new URLSearchParams(f).toString();
    return Promise.all([API.get("/admin/courses"), API.get("/admin/sessions" + q)]).then(function (res) {
      var courses = res[0], rows = res[1];
      app.innerHTML =
        '<div class="page-head"><h1>Sessions</h1><a class="btn" href="#/dashboard">New session</a></div>' +
        '<section class="card"><form id="filter" class="row" style="align-items:flex-end"><div><label for="fc">Course</label><select id="fc" name="course"><option value="">All courses</option>' +
        courses.map(function (c) { return '<option value="' + esc(c.id) + '"' + (f.course === c.id ? " selected" : "") + ">" + esc(c.code) + "</option>"; }).join("") + "</select></div>" +
        '<div><label for="ff">From</label><input id="ff" type="date" name="from" value="' + esc(f.from) + '"></div>' +
        '<div><label for="ft">To</label><input id="ft" type="date" name="to" value="' + esc(f.to) + '"></div>' +
        '<div style="flex:0 0 auto" class="actions"><button class="btn" type="submit">Filter</button><a class="btn ghost" href="#/sessions">Clear</a></div></form></section>' +
        '<section class="card">' + (rows.length ? sessionRowsTable(rows) : '<div class="empty">No sessions match. Clear the filters or create a session.</div>') + "</section>";
      onSubmit($("#filter"), function (d) { go("#/sessions?" + new URLSearchParams(d).toString()); });
    });
  }

  // ------------------------------------------------------------ one session (QR + live roster)
  function rosterBody(d) {
    return d.roster.map(function (r) {
      return "<tr><td>" + esc(r.roll) + "</td><td>" + esc(r.name) + "</td><td>" +
        (r.at ? '<span class="badge present">Present</span>' : '<span class="badge absent">Absent</span>') +
        (r.source === "manual" ? ' <span class="badge manual">manual</span>' : "") + "</td><td>" + esc(fmtTime(r.at)) + '</td><td class="num">' +
        '<button class="btn sm ghost" type="button" data-manual="' + esc(r.roll) + '">' + (r.at ? "Undo" : "Mark present") + "</button></td></tr>";
    }).join("");
  }

  function viewSession(id) {
    return API.get("/admin/sessions/" + encodeURIComponent(id)).then(function (d) {
      var s = d.session, c = d.course;
      var url = location.origin + "/a/" + s.id;
      var left = d.secondsLeft;

      app.innerHTML =
        '<div class="page-head"><div><h1>' + esc(s.title) + '</h1><p class="muted">' + esc(c.code) + " - " + esc(c.name) + " &middot; " + esc(s.date) + ", " + esc(s.start) + "-" + esc(s.end) + "</p></div>" +
        '<button class="btn danger sm" id="del-session" type="button">Delete session</button></div><div class="session-grid">' +
        '<section class="card qr-box"><h2>Scan to mark attendance</h2><div class="qr" id="qr"></div>' +
        '<div class="url-box"><input id="session-url" value="' + esc(url) + '" readonly aria-label="Attendance link"><button class="btn ghost sm" id="copy" type="button">Copy</button></div>' +
        '<p><span id="open-badge"></span> <span class="timer" id="timer"></span></p>' +
        '<a class="btn block" target="_blank" rel="noopener" href="/present.html?s=' + esc(s.id) + '">Show full screen for the class</a>' +
        '<div class="actions" style="margin-top:.75rem;justify-content:center"><input id="minutes" type="number" value="10" min="1" max="600" style="width:80px" aria-label="Minutes to open">' +
        '<button class="btn ghost sm" id="reopen" type="button"></button><button class="btn danger sm" id="close-now" type="button">Close now</button></div></section>' +
        '<section class="card"><div class="stats" style="margin-bottom:1rem"><div class="stat ok"><b id="n-present"></b><span>Present</span></div>' +
        '<div class="stat bad"><b id="n-absent"></b><span>Absent</span></div><div class="stat"><b><span id="n-pct"></span>%</b><span>Attendance</span></div></div>' +
        "<h2>Attendance for this session</h2>" +
        (d.roster.length
          ? '<div class="table-wrap"><table><thead><tr><th>Student ID</th><th>Name</th><th>Status</th><th>Time</th><th></th></tr></thead><tbody id="roster"></tbody></table></div>'
          : '<div class="empty">This course has no students yet. <a href="#/courses/' + esc(c.id) + '">Add the class list</a>.</div>') +
        '<p class="muted small" style="margin-top:.75rem">This table updates by itself every 5 seconds. "Mark present" is the instructor-confirmation override.</p></section></div>';

      $("#qr").innerHTML = qrSvg(url);

      function paintTimer() {
        $("#open-badge").innerHTML = openBadge(left > 0);
        $("#timer").textContent = left > 0 ? fmtClock(left) : "--";
        $("#reopen").textContent = left > 0 ? "Add minutes" : "Reopen";
        $("#close-now").hidden = left <= 0;
      }
      function paint(data) {
        left = data.secondsLeft;
        $("#n-present").textContent = data.present;
        $("#n-absent").textContent = data.total - data.present;
        $("#n-pct").textContent = data.total ? Math.round(1000 * data.present / data.total) / 10 : 0;
        if ($("#roster")) $("#roster").innerHTML = rosterBody(data);
        paintTimer();
      }
      function refresh() { return API.get("/admin/sessions/" + encodeURIComponent(id)).then(paint); }
      paint(d);

      every(1000, function () { if (left > 0) { left--; paintTimer(); } });
      every(5000, function () { refresh().catch(function () {}); });

      $("#copy").addEventListener("click", function () {
        var b = this, input = $("#session-url");
        var done = function () { b.textContent = "Copied"; setTimeout(function () { b.textContent = "Copy"; }, 1400); };
        if (navigator.clipboard) navigator.clipboard.writeText(url).then(done); else { input.select(); document.execCommand("copy"); done(); }
      });
      $("#reopen").addEventListener("click", function () {
        API.post("/admin/sessions/" + id + "/open", { minutes: $("#minutes").value }).then(refresh).then(function () { flash("QR code is open."); }).catch(fail);
      });
      $("#close-now").addEventListener("click", function () {
        API.post("/admin/sessions/" + id + "/close").then(refresh).then(function () { flash("Attendance closed. The QR code no longer accepts submissions."); }).catch(fail);
      });
      if ($("#roster")) $("#roster").addEventListener("click", function (e) {
        var b = e.target.closest("[data-manual]");
        if (!b) return;
        b.disabled = true;
        API.post("/admin/sessions/" + id + "/manual", { roll: b.dataset.manual }).then(refresh).catch(function (err) { b.disabled = false; fail(err); });
      });
      $("#del-session").addEventListener("click", function () {
        if (!confirm("Delete this session and its attendance records?")) return;
        API.del("/admin/sessions/" + id).then(function () { flash("Session deleted."); go("#/sessions"); }).catch(fail);
      });
    });
  }

  // ------------------------------------------------------------ reports + CSV export
  function viewReports(p) {
    var f = { course: p.get("course") || "", session: p.get("session") || "", from: p.get("from") || "", to: p.get("to") || "" };
    var qs = new URLSearchParams(f).toString();
    var jobs = [API.get("/admin/courses")];
    if (f.course) {
      jobs.push(API.get("/admin/sessions?course=" + encodeURIComponent(f.course)));
      jobs.push(API.get("/admin/reports?" + qs));
    }
    return Promise.all(jobs).then(function (res) {
      var courses = res[0], courseSessions = res[1] || [], rep = res[2];
      var head =
        '<div class="page-head"><h1>Reports</h1></div><section class="card"><form id="filter" class="row" style="align-items:flex-end">' +
        '<div><label for="rc">Course</label><select id="rc" name="course"><option value="">Choose a course</option>' +
        courses.map(function (c) { return '<option value="' + esc(c.id) + '"' + (f.course === c.id ? " selected" : "") + ">" + esc(c.code) + " - " + esc(c.name) + "</option>"; }).join("") + "</select></div>" +
        '<div><label for="rs">Single session</label><select id="rs" name="session"' + (f.course ? "" : " disabled") + '><option value="">All sessions</option>' +
        courseSessions.map(function (s) { return '<option value="' + esc(s.id) + '"' + (f.session === s.id ? " selected" : "") + ">" + esc(s.date) + " - " + esc(s.title) + "</option>"; }).join("") + "</select></div>" +
        '<div><label for="rf">From</label><input id="rf" type="date" name="from" value="' + esc(f.from) + '"></div>' +
        '<div><label for="rt">To</label><input id="rt" type="date" name="to" value="' + esc(f.to) + '"></div>' +
        '<div style="flex:0 0 auto"><button class="btn" type="submit">Apply filters</button></div></form></section>';

      if (!rep) {
        app.innerHTML = head + '<div class="card empty">Choose a course to see class statistics and each student\'s attendance percentage.</div>';
      } else {
        app.innerHTML = head +
          '<div class="stats"><div class="stat"><b>' + rep.totalSessions + "</b><span>Sessions in range</span></div><div class=\"stat\"><b>" + rep.totalStudents + "</b><span>Students</span></div>" +
          '<div class="stat ok"><b>' + rep.overall + '%</b><span>Class attendance</span></div><div class="stat bad"><b>' + rep.low + "</b><span>Students under " + rep.lowThreshold + "%</span></div></div>" +
          '<div class="actions no-print" style="margin-bottom:1.25rem"><button class="btn" id="x-sum" type="button">Export summary (CSV / Excel)</button>' +
          '<button class="btn ghost" id="x-rec" type="button">Export every record (CSV / Excel)</button><button class="btn ghost" type="button" onclick="window.print()">Print</button></div>' +
          '<section class="card"><h2>Class statistics by session</h2>' +
          (rep.sessions.length
            ? '<div class="table-wrap"><table><thead><tr><th>Date</th><th>Session</th><th>Time</th><th class="num">Present</th><th class="num">Absent</th><th class="num">Attendance</th></tr></thead><tbody>' +
              rep.sessions.map(function (r) {
                return "<tr><td>" + esc(r.date) + '</td><td><a href="#/sessions/' + esc(r.id) + '">' + esc(r.title) + "</a></td><td>" + esc(r.time) + '</td><td class="num">' + r.present + '</td><td class="num">' + r.absent + '</td><td class="num">' + r.pct + "%</td></tr>";
              }).join("") + "</tbody></table></div>"
            : '<div class="empty">No sessions in this range.</div>') + "</section>" +
          '<section class="card"><h2>Attendance percentage per student</h2>' +
          (rep.students.length
            ? '<div class="table-wrap"><table><thead><tr><th>Student ID</th><th>Name</th><th class="num">Present</th><th class="num">Absent</th><th style="width:22%">Attendance</th></tr></thead><tbody>' +
              rep.students.map(function (r) {
                var low = rep.totalSessions && r.pct < rep.lowThreshold;
                return '<tr class="' + (low ? "low" : "") + '"><td>' + esc(r.roll) + "</td><td>" + esc(r.name) + '</td><td class="num">' + r.present + '</td><td class="num">' + r.absent + "</td>" +
                  '<td><div class="actions" style="flex-wrap:nowrap"><div class="bar ' + (low ? "low" : "") + '" style="flex:1"><i style="width:' + r.pct + '%"></i></div><b>' + r.pct + "%</b></div></td></tr>";
              }).join("") + '</tbody></table></div><p class="muted small" style="margin-top:.75rem">A red marker means attendance is under ' + rep.lowThreshold + "%.</p>"
            : '<div class="empty">No students in this course yet.</div>') + "</section>";

        var stamp = today().replace(/-/g, "");
        $("#x-sum").addEventListener("click", function () {
          var rows = [["student_id", "name", "sessions_present", "sessions_absent", "total_sessions", "attendance_percent"]];
          rep.students.forEach(function (r) { rows.push([r.roll, r.name, r.present, r.absent, rep.totalSessions, r.pct]); });
          download(rep.course.code + "_summary_" + stamp + ".csv", toCsv(rows));
        });
        $("#x-rec").addEventListener("click", function () {
          API.get("/admin/reports?" + qs + "&records=1").then(function (full) {
            var rows = [["date", "session", "class_time", "student_id", "name", "status", "marked_at", "source"]];
            full.records.forEach(function (r) { rows.push([r.date, r.session, r.time, r.roll, r.name, r.status, r.markedAt, r.source]); });
            download(rep.course.code + "_records_" + stamp + ".csv", toCsv(rows));
          }).catch(fail);
        });
      }
      $("#rc").addEventListener("change", function () { go("#/reports?course=" + encodeURIComponent(this.value)); });
      onSubmit($("#filter"), function (d) {
        Object.keys(d).forEach(function (k) { if (!d[k]) delete d[k]; });
        go("#/reports?" + new URLSearchParams(d).toString());
      });
    });
  }

  route();
})();
