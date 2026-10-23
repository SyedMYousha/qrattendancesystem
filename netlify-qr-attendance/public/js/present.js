/* Full-screen QR for projecting in class. Needs the instructor to be signed in. */
(function () {
  "use strict";
  var sid = new URLSearchParams(location.search).get("s");
  var left = 0;
  var timerEl = document.getElementById("timer");

  if (!API.token() || !sid) { location.href = "/admin.html"; return; }
  document.getElementById("back").href = "/admin.html#/sessions/" + encodeURIComponent(sid);

  function paint() { timerEl.textContent = left > 0 ? fmtClock(left) : "Closed"; }
  function refresh(first) {
    API.get("/admin/sessions/" + encodeURIComponent(sid)).then(function (d) {
      if (first) {
        var url = location.origin + "/a/" + d.session.id;
        document.getElementById("heading").textContent = d.course.code + ": scan to mark your attendance";
        document.getElementById("qr").innerHTML = qrSvg(url);
        document.getElementById("link").textContent = url;
        document.title = d.session.title + " - scan to mark attendance";
      }
      document.getElementById("count").textContent = d.present;
      left = d.secondsLeft; paint();
    }).catch(function () {});
  }
  window.addEventListener("qa-signed-out", function () { location.href = "/admin.html"; });
  refresh(true);
  setInterval(refresh, 5000);
  setInterval(function () { if (left > 0) { left--; paint(); } }, 1000);
})();
