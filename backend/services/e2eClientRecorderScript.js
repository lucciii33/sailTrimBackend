// The recorder that Olivia injects into the CLOUD browser (via Playwright
// addInitScript) — NOT into the customer's app. The customer never installs or
// pastes anything; they just drive the cloud browser from the embedded live
// view. This runs on every document, captures the real clicks/fills with real
// selectors, and streams them to our /ingest endpoint.
//
// Verified working end to end against a live Browserbase session (session +
// CDP + addInitScript + capture across multiple navigations).
//
// `token` ties the events to one E2eRecordingSession. `endpoint` is the
// absolute URL of the ingest route (absolute because this runs inside the
// cloud browser on the customer's app origin, not on ours).
function clientRecorderScript({ token, endpoint }) {
  const cfg = JSON.stringify({ token, endpoint });
  return `(function () {
  if (window.__oliviaRecorder) return;
  window.__oliviaRecorder = true;
  var CFG = ${cfg};

  function cssEscape(v) {
    if (window.CSS && CSS.escape) return CSS.escape(v);
    return String(v).replace(/[^a-zA-Z0-9_-]/g, "\\\\$&");
  }

  function shortText(el) {
    return String(
      (el.getAttribute && el.getAttribute("aria-label")) ||
        el.innerText || el.value ||
        (el.getAttribute && el.getAttribute("placeholder")) || ""
    ).replace(/\\s+/g, " ").trim().slice(0, 120);
  }

  function roleOf(el) {
    var explicit = el.getAttribute && el.getAttribute("role");
    if (explicit) return explicit;
    var tag = el.tagName.toLowerCase();
    var type = (el.getAttribute("type") || "").toLowerCase();
    if (tag === "button" || type === "button" || type === "submit") return "button";
    if (tag === "a") return "link";
    if (tag === "input" || tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    return "";
  }

  // Prefer a stable selector: data-testid > id > a short structural path.
  function selectorFor(el) {
    if (!el || el.nodeType !== 1) return "";
    var testId = el.getAttribute("data-testid") || el.getAttribute("data-test-id") ||
      el.getAttribute("data-cy") || el.getAttribute("data-qa");
    if (testId) return '[data-testid=' + JSON.stringify(testId) + ']';
    if (el.id) return "#" + cssEscape(el.id);
    var parts = [], node = el;
    while (node && node.nodeType === 1 && parts.length < 5) {
      var part = node.tagName.toLowerCase();
      if (node.classList && node.classList.length) {
        part += "." + Array.prototype.slice.call(node.classList, 0, 2).map(cssEscape).join(".");
      }
      var parent = node.parentElement;
      if (parent) {
        var same = Array.prototype.filter.call(parent.children, function (c) {
          return c.tagName === node.tagName;
        });
        if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(" > ");
  }

  function payload(type, el, extra) {
    var testId = el && (el.getAttribute("data-testid") || el.getAttribute("data-test-id") ||
      el.getAttribute("data-cy") || el.getAttribute("data-qa"));
    var base = {
      token: CFG.token, type: type, url: location.href, title: document.title,
      selector: selectorFor(el), testId: testId || null,
      role: el ? roleOf(el) : "", text: el ? shortText(el) : "", ts: Date.now()
    };
    if (extra) for (var k in extra) base[k] = extra[k];
    return base;
  }

  function send(data) {
    var body = JSON.stringify(data);
    // text/plain keeps this a CORS "simple request" (no preflight) — the
    // recorder runs on the customer's app origin inside the cloud browser and
    // POSTs cross-origin to Olivia; the server JSON.parses the text body.
    try {
      if (navigator.sendBeacon &&
          navigator.sendBeacon(CFG.endpoint, new Blob([body], { type: "text/plain" }))) return;
    } catch (e) {}
    fetch(CFG.endpoint, {
      method: "POST", headers: { "Content-Type": "text/plain" },
      body: body, keepalive: true, credentials: "omit"
    }).catch(function () {});
  }

  send(payload("navigate", document.documentElement));

  document.addEventListener("click", function (e) {
    var el = e.target && e.target.closest &&
      e.target.closest("button,a,input,textarea,select,[role],[data-testid],[data-test-id],[data-cy],[data-qa]");
    if (!el) return;
    send(payload("click", el));
  }, true);

  document.addEventListener("change", function (e) {
    var el = e.target;
    if (!el || !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
    if ((el.getAttribute("type") || "").toLowerCase() === "password") {
      send(payload("fill", el, { value: "", sensitive: true }));
      return;
    }
    send(payload("fill", el, { value: String(el.value || "").slice(0, 500) }));
  }, true);
})();`;
}

module.exports = { clientRecorderScript };
