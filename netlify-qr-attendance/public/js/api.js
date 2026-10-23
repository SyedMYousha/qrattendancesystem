/* Tiny fetch wrapper shared by every page. */
var API = (function () {
  "use strict";
  var KEY = "qa_token";

  function token() { return localStorage.getItem(KEY) || ""; }
  function setToken(t) { if (t) localStorage.setItem(KEY, t); else localStorage.removeItem(KEY); }

  function call(method, path, body) {
    var headers = { "Content-Type": "application/json" };
    if (token()) headers.Authorization = "Bearer " + token();
    return fetch("/api" + path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (res.status === 401 && path.indexOf("/admin") === 0) {
            setToken("");
            window.dispatchEvent(new Event("qa-signed-out"));
          }
          if (!res.ok) {
            var err = new Error(data.error || "Request failed (" + res.status + ")");
            err.status = res.status;
            throw err;
          }
          return data;
        });
      });
  }

  return {
    token: token, setToken: setToken,
    get: function (p) { return call("GET", p); },
    post: function (p, b) { return call("POST", p, b || {}); },
    del: function (p) { return call("DELETE", p); }
  };
})();

/* Shared helpers */
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function qrSvg(text) {
  var qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 8, margin: 16, scalable: true, alt: "QR code for the attendance link" });
}
function fmtClock(sec) {
  var m = Math.floor(sec / 60), s = sec % 60;
  return m + ":" + (s < 10 ? "0" : "") + s;
}
function fmtTime(iso) {
  return iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
}
