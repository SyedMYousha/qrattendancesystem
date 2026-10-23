/* Student page: opened by scanning the QR code (/a/<session-id>). */
(function () {
  "use strict";
  var card = document.getElementById("card");
  var m = location.pathname.match(/\/a\/([^\/?#]+)/);
  var sid = m ? decodeURIComponent(m[1]) : new URLSearchParams(location.search).get("s");

  // A random id kept on this phone. It stops one phone marking several different students.
  function deviceId() {
    try {
      var d = localStorage.getItem("qa_device");
      if (!d) {
        d = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now()).replace(/[^A-Za-z0-9_-]/g, "");
        localStorage.setItem("qa_device", d);
      }
      return d;
    } catch (e) { return ""; }
  }

  function header(s) {
    return '<div class="course">' + esc(s.courseCode) + " &middot; " + esc(s.courseName) + "</div>" +
      "<h1>" + esc(s.title) + "</h1>" +
      '<dl class="meta"><dt>Date</dt><dd>' + esc(s.date) + "</dd><dt>Class time</dt><dd>" + esc(s.start) + " to " + esc(s.end) + "</dd></dl>";
  }

  function showForm(s, error, roll) {
    var body = header(s);
    if (error) body += '<div class="flash error" role="alert">' + esc(error) + "</div>";
    if (!s.isOpen) {
      body += '<div class="flash error">Attendance is closed for this session. Ask your instructor to reopen it.</div>' +
              '<button class="btn ghost block" id="again" type="button">Check again</button>';
      card.innerHTML = body;
      document.getElementById("again").onclick = load;
      return;
    }
    body += '<form id="f" autocomplete="off"><div class="field"><label for="roll_no">Your student ID</label>' +
      '<input id="roll_no" class="big-input" value="' + esc(roll || "") + '" autocapitalize="characters" required></div>' +
      '<button class="btn block" id="go" type="submit">Mark me present</button></form>' +
      '<p class="muted small" style="margin-top:1rem">Only your student ID is used. Your name is shown after it is recorded so you can confirm it is you.</p>';
    card.innerHTML = body;
    var input = document.getElementById("roll_no");
    input.focus();
    document.getElementById("f").onsubmit = function (e) {
      e.preventDefault();
      var value = input.value.trim();
      var btn = document.getElementById("go");
      btn.disabled = true; btn.textContent = "Sending...";
      API.post("/public/sessions/" + encodeURIComponent(sid) + "/attend", { roll: value, device: deviceId() })
        .then(function (r) { showResult(s, r); })
        .catch(function (err) {
          if (err.status === 409) { s.isOpen = false; }
          showForm(s, err.message, value);
        });
    };
  }

  function showResult(s, r) {
    var done = r.status === "ok";
    card.innerHTML = header(s) +
      '<div class="result' + (done ? "" : " notice") + '" role="status"><div class="tick" aria-hidden="true">' + (done ? "&#10003;" : "!") + "</div>" +
      (done
        ? "<h2>You are marked present</h2><p>" + esc(r.name) + " (" + esc(r.roll) + ')<br><span class="muted">Recorded at ' + esc(fmtTime(r.at)) + ". You can close this page.</span></p>"
        : "<p>" + esc(r.name) + ", you are already marked present (at " + esc(fmtTime(r.at)) + "). Nothing more to do.</p>") +
      "</div>";
  }

  function load() {
    if (!sid) { card.innerHTML = "<h1>Missing session</h1><p class='muted'>Scan the QR code your instructor is showing.</p>"; return; }
    API.get("/public/sessions/" + encodeURIComponent(sid))
      .then(function (s) { showForm(s); })
      .catch(function (err) {
        card.innerHTML = "<h1>" + (err.status === 404 ? "Session not found" : "Could not load") + "</h1><p class='muted'>" +
          esc(err.status === 404 ? "This QR code does not match an attendance session. Ask your instructor to show it again." : err.message) + "</p>";
      });
  }
  load();
})();
