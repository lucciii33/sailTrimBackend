// Does this spec actually TEST anything?
//
// The heal loop's reward is "make it pass", and the cheapest way to make any test
// pass is to stop asserting. Left alone, the model learns exactly that, and
// produces specs like:
//
//   await expect(page).toHaveURL(/E2E-QA|login/i)   // passes either way
//   await expect(page.locator("body")).toBeVisible() // always true
//
// Green, worthless, and committed. So a run is only accepted when the spec also
// survives these rules. A violation is fed back as a failure, with the rule
// named, which keeps the loop pointed at "write a real test" instead of "get
// past the checker".
//
// Rules are deliberately mechanical: they look for the shapes that always mean
// "this asserts nothing", never for style. Something subtler belongs in review,
// not here.

// Locators that are true on any page, including an error page.
const VACUOUS_LOCATORS =
  /(page\.locator\(\s*["'`](body|html|#root|#app|main|\*)["'`]\s*\)|page\.locator\(\s*["'`][^"'`]*\b(body|#root|#app)\b[^"'`]*["'`]\s*\))/;

// An assertion that accepts the app being anywhere is not an assertion. The
// common shape is a URL regex with alternation, usually with a login fallback.
const URL_ASSERTION = /toHaveURL\(\s*([^)]*)\)/g;

// Evidence that the spec checks the product, not the page skeleton.
const REAL_LOCATOR =
  /(getByTestId|getByRole|getByLabel|getByPlaceholder|getByText|getByTitle|data-testid=)/;

const ASSERTION = /expect\s*\(/g;

function countMatches(text, re) {
  return (text.match(re) || []).length;
}

/**
 * @param specCode   the spec the model just produced
 * @param intent     { gherkinText, name } — used only to allow login-specific
 *                   tests to assert on the login page
 * @returns {{ ok: boolean, violations: string[] }}
 */
function auditSpec(specCode, intent = {}) {
  const code = String(specCode || "");
  const violations = [];
  const isLoginTest = /log\s?in|sign\s?in|auth|logout|sign\s?out/i.test(
    `${intent.name || ""} ${intent.gherkinText || ""}`
  );

  if (countMatches(code, ASSERTION) < 2) {
    violations.push(
      "The spec has fewer than two assertions. A test must verify the outcome of the flow, not just walk through it."
    );
  }

  if (!REAL_LOCATOR.test(code)) {
    violations.push(
      "No assertion targets real app content. Use getByTestId / getByRole / getByText on elements that only exist when the flow actually worked."
    );
  }

  if (VACUOUS_LOCATORS.test(code)) {
    violations.push(
      'Asserting that body / #root / main is visible proves nothing — those exist on an error page too. Remove it and assert on the content the flow produces.'
    );
  }

  // URL assertions: alternation means "any of these is fine", which is how a
  // failed session gets accepted as success.
  let m;
  URL_ASSERTION.lastIndex = 0;
  while ((m = URL_ASSERTION.exec(code))) {
    const arg = m[1] || "";
    if (arg.includes("|")) {
      violations.push(
        `toHaveURL(${arg.trim()}) accepts more than one destination. Assert the ONE URL the flow must reach.`
      );
    }
    if (!isLoginTest && /login|signin|sign-in/i.test(arg)) {
      violations.push(
        `toHaveURL(${arg.trim()}) treats the login page as a valid outcome. If the session wasn't applied the test must FAIL, not pass — that's the bug worth reporting.`
      );
    }
  }

  // Landing on login is a failed session, not a result — unless that is the test.
  if (!isLoginTest && /\/login|\/signin|\/sign-in/i.test(code) && /expect\s*\(/.test(code)) {
    const assertsLogin = /expect[^;]{0,200}(login|signin|sign-in)/i.test(code);
    if (assertsLogin) {
      violations.push(
        "The spec asserts something about the login page. This test is not about logging in, so reaching login means the session was lost — let it fail."
      );
    }
  }

  if (/waitForTimeout|page\.pause\(/.test(code)) {
    violations.push(
      "Remove waitForTimeout / page.pause — they hide real timing problems and make the test flaky."
    );
  }

  if (/test\.(skip|fixme)\(|\.skip\(/.test(code)) {
    violations.push("The spec skips tests. A skipped test is not a passing test.");
  }

  return { ok: violations.length === 0, violations };
}

/** The message fed back to the model when a spec passed but says nothing. */
function auditFeedback(violations) {
  return [
    "The test executed GREEN, but it does not actually verify the behaviour, so it is rejected:",
    ...violations.map((v) => `- ${v}`),
    "",
    "Rewrite it so that it would FAIL if the feature were broken. Return the FULL corrected spec in one ```typescript block.",
  ].join("\n");
}

module.exports = { auditSpec, auditFeedback };
