/**
 * Standalone HTML pages shown to the user after they interact with the
 * GitHub App install flow (they land on our /api/github/callback URL).
 *
 * These are full self-contained documents (inline CSS, no external assets)
 * because they're served directly as an HTTP response by the callback — the
 * browser renders them as a normal web page, not inside our SPA. Theme-aware
 * (light/dark via prefers-color-scheme) and responsive.
 */

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * @param {object} opts
 * @param {"success"|"pending"|"error"} opts.variant
 * @param {string} opts.title      big heading
 * @param {string} opts.message    paragraph under the heading
 * @param {string} [opts.ctaHref]  optional button link
 * @param {string} [opts.ctaLabel] optional button text
 */
function renderGithubResultPage({ variant, title, message, ctaHref, ctaLabel }) {
  const icons = {
    success: "✓",
    pending: "⏳",
    error: "!",
  };
  const accents = {
    success: "#1a7f37",
    pending: "#9a6700",
    error: "#cf222e",
  };
  const accent = accents[variant] || accents.pending;
  const icon = icons[variant] || icons.pending;

  const cta =
    ctaHref && ctaLabel
      ? `<a class="cta" href="${escapeHtml(ctaHref)}">${escapeHtml(ctaLabel)}</a>`
      : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)} · OliviaTools</title>
<style>
  :root {
    --bg: #f6f8fa;
    --card: #ffffff;
    --text: #1f2328;
    --muted: #656d76;
    --border: #d0d7de;
    --accent: ${accent};
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0d1117;
      --card: #161b22;
      --text: #e6edf3;
      --muted: #8b949e;
      --border: #30363d;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    line-height: 1.5;
  }
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 40px 32px;
    max-width: 440px;
    width: 100%;
    text-align: center;
    box-shadow: 0 1px 3px rgba(0,0,0,0.08);
  }
  .badge {
    width: 56px;
    height: 56px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    margin: 0 auto 20px;
    font-size: 28px;
    font-weight: 700;
    color: #fff;
    background: var(--accent);
  }
  h1 {
    font-size: 20px;
    margin: 0 0 12px;
    font-weight: 600;
  }
  p {
    color: var(--muted);
    font-size: 15px;
    margin: 0 0 24px;
  }
  .cta {
    display: inline-block;
    background: var(--accent);
    color: #fff;
    text-decoration: none;
    padding: 10px 20px;
    border-radius: 8px;
    font-size: 14px;
    font-weight: 600;
  }
  .cta:hover { opacity: 0.92; }
  .brand {
    margin-top: 28px;
    font-size: 12px;
    color: var(--muted);
    letter-spacing: 0.02em;
  }
</style>
</head>
<body>
  <div class="card">
    <div class="badge">${icon}</div>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
    ${cta}
    <div class="brand">OliviaTools</div>
  </div>
</body>
</html>`;
}

module.exports = { renderGithubResultPage };
