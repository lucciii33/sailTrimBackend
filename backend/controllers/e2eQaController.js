const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const mongoose = require("mongoose");
const E2eProject = require("../model/E2eProject");
const E2eFeature = require("../model/E2eFeature");
const E2eTest = require("../model/E2eTest");
const E2eRecordingSession = require("../model/E2eRecordingSession");
const e2eQaService = require("../services/e2eQaService");
const e2eHealService = require("../services/e2eHealService");
const { recordSpec } = require("../services/e2eRecorderService");
const browserbase = require("../services/e2eBrowserbaseService");
const { actionsToPlaywrightSpec } = require("../services/e2eActionsToSpec");
const { resolveOctokit } = require("../services/repoContextService");
const { commitFileToBranch, getDefaultBranch } = require("../services/githubService");
const { encrypt, decrypt, maskSecret } = require("../services/secretCrypto");
const { getUserAnthropicClient } = require("../services/userKeyService");
const { parseGherkinText } = require("../services/gherkinText");

// Where the per-project authenticated Playwright session lives. Gitignored —
// it holds live session cookies. (Productized: encrypt + store in S3.)
const AUTH_DIR = path.resolve(__dirname, "../.e2e-auth");
function authPathFor(projectId, env) {
  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
  // No env → legacy single-session path (keeps already-captured sessions valid).
  const suffix = env ? `__${String(env).replace(/[^a-z0-9_-]/gi, "_")}` : "";
  return path.join(AUTH_DIR, `${projectId}${suffix}.json`);
}

// Save a captured session onto the project (or one environment). The encrypted
// copy is the source of truth; the file is just a local cache the Playwright
// runner reads (ensureStorageStateFile restores it from the encrypted copy when
// it's missing, e.g. on a fresh dyno).
function persistStorageStateJson(target, json, filePath) {
  if (filePath) fs.writeFileSync(filePath, json, "utf8");
  const slot = target.env ? target.env : target.project.login;
  if (filePath) slot.storageStatePath = filePath;
  slot.storageStateEncrypted = encrypt(json);
}

function persistStorageState(target, filePath) {
  persistStorageStateJson(target, fs.readFileSync(filePath, "utf8"), filePath);
}

function ensureStorageStateFile(project, target) {
  const storagePath = target.storageStatePath;
  if (storagePath && fs.existsSync(storagePath)) return storagePath;

  const encrypted = target.env
    ? target.env.storageStateEncrypted
    : project.login?.storageStateEncrypted;
  if (!encrypted) return "";

  const json = decrypt(encrypted);
  if (!json) return "";

  const restoredPath = authPathFor(project._id, target.env ? target.name : undefined);
  fs.writeFileSync(restoredPath, json, "utf8");

  if (target.env) {
    target.env.storageStatePath = restoredPath;
  } else {
    project.login.storageStatePath = restoredPath;
  }
  return restoredPath;
}

// Find a named environment on a project. Returns the subdoc (mutable) or null.
function resolveEnv(project, envName) {
  if (!envName) return null;
  return (project.environments || []).find((e) => e.name === envName) || null;
}

// The run target for a request: the named environment when given, else the
// legacy project-level baseUrl + login (so old projects keep working).
function resolveTarget(project, envName) {
  const env = resolveEnv(project, envName);
  if (env) {
    return {
      env,
      name: env.name,
      baseUrl: env.baseUrl || "",
      loginUrl: env.loginUrl || "",
      storageStatePath: env.storageStatePath || "",
      authReady: Boolean(env.authSavedAt),
    };
  }
  return {
    project,
    env: null,
    name: "",
    baseUrl: project.baseUrl || "",
    loginUrl: project.login?.url || "",
    storageStatePath: project.login?.storageStatePath || "",
    authReady: Boolean(project.login?.authSavedAt),
  };
}

// The cloud browser runs in Browserbase's datacenter, so "localhost" there
// resolves to Browserbase's own container — not the machine the customer is
// sitting at. A local URL doesn't fail in some subtle way, it just shows
// ERR_CONNECTION_REFUSED inside the iframe, which reads like our bug. Catch it
// up front and say what to do instead.
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]);
function unreachableFromCloud(rawUrl) {
  let host;
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch (_) {
    return ""; // not parseable — let the navigation fail on its own
  }
  const isLocal =
    LOCAL_HOSTNAMES.has(host) ||
    host.endsWith(".local") ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (!isLocal) return "";
  return (
    `The cloud browser can't reach ${host} — it runs in the cloud, so "${host}" ` +
    `points at itself, not at your machine. Use a URL that's reachable from the ` +
    `internet (staging or production), or expose your local app with a tunnel ` +
    `(ngrok, cloudflared) and set that URL as the base URL.`
  );
}

// Turn a test name into a safe file slug for the spec path on commit.
function slugify(name) {
  return (
    String(name || "test")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "test"
  );
}

function requireCompany(req, res) {
  if (!req.user.companyId) {
    res.status(400).json({ message: "User has no company" });
    return false;
  }
  return true;
}

function serializeProject(p) {
  if (!p) return null;
  const login = p.login || {};
  return {
    _id: p._id,
    name: p.name,
    title: p.title,
    baseUrl: p.baseUrl || "",
    login: {
      url: login.url || "",
      username: login.username || "",
      passwordMasked: maskSecret(decrypt(login.passwordEncrypted)),
      usernameSelector: login.usernameSelector || "",
      passwordSelector: login.passwordSelector || "",
      submitSelector: login.submitSelector || "",
      // Whether the one-time authenticated session has been captured.
      authReady: Boolean(login.authSavedAt),
      authSavedAt: login.authSavedAt || null,
    },
    environments: (p.environments || []).map((e) => ({
      name: e.name,
      baseUrl: e.baseUrl || "",
      loginUrl: e.loginUrl || "",
      authReady: Boolean(e.authSavedAt),
      authSavedAt: e.authSavedAt || null,
    })),
    github: p.github || {},
    variables: (p.variables || []).map((v) => ({
      key: v.key,
      secret: !!v.secret,
      value: v.secret ? maskSecret(decrypt(v.value)) : v.value,
    })),
    updatedAt: p.updatedAt,
  };
}

// ----------------------------- Projects -----------------------------

async function listProjects(req, res) {
  if (!requireCompany(req, res)) return;
  const projects = await E2eProject.find({
    companyId: req.user.companyId,
  }).sort({ updatedAt: -1 });
  res.json(projects.map(serializeProject));
}

async function createProject(req, res) {
  if (!requireCompany(req, res)) return;
  const { name, title, baseUrl, github, environments } = req.body;
  if (!name) return res.status(400).json({ message: "name is required" });
  try {
    const envs = Array.isArray(environments)
      ? environments
          .filter((e) => e && e.name)
          .map((e) => ({
            name: e.name,
            baseUrl: e.baseUrl || "",
            loginUrl: e.loginUrl || "",
          }))
      : [];
    const project = await E2eProject.create({
      userId: req.user._id,
      companyId: req.user.companyId,
      name,
      title: title || name,
      baseUrl: baseUrl || "",
      environments: envs,
      // Repo picked from the connected-installations dropdown. Lets the
      // improve/heal step read the repo's helpers + data-testids. Optional.
      github: github
        ? {
            owner: github.owner || "",
            repo: github.repo || "",
            branch: github.branch || "",
            testDir: github.testDir || "tests/e2e",
          }
        : undefined,
    });
    res.status(201).json(serializeProject(project));
  } catch (err) {
    if (err.code === 11000) {
      return res
        .status(409)
        .json({ message: "A project with that name already exists" });
    }
    throw err;
  }
}

async function getProject(req, res) {
  if (!requireCompany(req, res)) return;
  const project = await E2eProject.findOne({
    _id: req.params.id,
    companyId: req.user.companyId,
  });
  if (!project) return res.status(404).json({ message: "Project not found" });
  res.json(serializeProject(project));
}

// Update baseUrl, login, github repo/branch, and variables. Secrets are only
// overwritten when a fresh (non-masked) value is supplied — so editing one
// field doesn't wipe a stored password.
async function updateProject(req, res) {
  if (!requireCompany(req, res)) return;
  const project = await E2eProject.findOne({
    _id: req.params.id,
    companyId: req.user.companyId,
  });
  if (!project) return res.status(404).json({ message: "Project not found" });

  const { title, baseUrl, login, github, variables, environments } = req.body;
  if (title != null) project.title = title;
  if (baseUrl != null) project.baseUrl = baseUrl;

  // Replace the environments list, but keep each env's captured session
  // (storageStatePath/authSavedAt) by matching on name — editing a baseUrl
  // must not log you out of that environment.
  if (Array.isArray(environments)) {
    const prev = new Map(
      (project.environments || []).map((e) => [e.name, e])
    );
    project.environments = environments
      .filter((e) => e && e.name)
      .map((e) => {
        const old = prev.get(e.name);
        return {
          name: e.name,
          baseUrl: e.baseUrl ?? old?.baseUrl ?? "",
          loginUrl: e.loginUrl ?? old?.loginUrl ?? "",
          storageStatePath: old?.storageStatePath || "",
          storageStateEncrypted: old?.storageStateEncrypted || "",
          authSavedAt: old?.authSavedAt || null,
        };
      });
  }

  if (login) {
    project.login = {
      url: login.url ?? project.login?.url ?? "",
      username: login.username ?? project.login?.username ?? "",
      passwordEncrypted: login.password
        ? encrypt(login.password)
        : project.login?.passwordEncrypted || "",
      usernameSelector:
        login.usernameSelector ?? project.login?.usernameSelector ?? "",
      passwordSelector:
        login.passwordSelector ?? project.login?.passwordSelector ?? "",
      submitSelector:
        login.submitSelector ?? project.login?.submitSelector ?? "",
      storageStatePath: project.login?.storageStatePath || "",
      storageStateEncrypted: project.login?.storageStateEncrypted || "",
      authSavedAt: project.login?.authSavedAt || null,
    };
  }

  if (github) {
    project.github = {
      owner: github.owner ?? project.github?.owner ?? "",
      repo: github.repo ?? project.github?.repo ?? "",
      branch: github.branch ?? project.github?.branch ?? "",
      testDir: github.testDir ?? project.github?.testDir ?? "tests/e2e",
    };
  }

  if (Array.isArray(variables)) {
    const prev = new Map((project.variables || []).map((v) => [v.key, v]));
    project.variables = variables
      .filter((v) => v && v.key)
      .map((v) => {
        if (!v.secret) return { key: v.key, value: v.value ?? "", secret: false };
        const incoming = v.value;
        const looksMasked = !incoming || /\*/.test(incoming);
        const value = looksMasked
          ? prev.get(v.key)?.value || ""
          : encrypt(incoming);
        return { key: v.key, value, secret: true };
      });
  }

  project.updatedAt = new Date();
  await project.save();
  res.json(serializeProject(project));
}

async function deleteProject(req, res) {
  if (!requireCompany(req, res)) return;
  const project = await E2eProject.findOneAndDelete({
    _id: req.params.id,
    companyId: req.user.companyId,
  });
  if (!project) return res.status(404).json({ message: "Project not found" });
  // Cascade: a project's features and tests go with it.
  await E2eFeature.deleteMany({
    projectId: project._id,
    companyId: req.user.companyId,
  });
  await E2eTest.deleteMany({
    projectId: project._id,
    companyId: req.user.companyId,
  });
  res.json({ message: "Project deleted" });
}

// ----------------------------- Features -----------------------------
// A feature groups tests inside a project. The video is dropped on a feature,
// not the project, so generated cases land grouped instead of flat.

function serializeFeature(f, testCount) {
  if (!f) return null;
  return {
    _id: f._id,
    projectId: f.projectId,
    name: f.name,
    description: f.description || "",
    testCount: typeof testCount === "number" ? testCount : undefined,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
  };
}

async function listFeatures(req, res) {
  if (!requireCompany(req, res)) return;
  const features = await E2eFeature.find({
    companyId: req.user.companyId,
    projectId: req.params.id,
  }).sort({ createdAt: -1 });

  // Attach a per-feature test count so the UI can show "3 tests" on each card.
  const counts = await E2eTest.aggregate([
    {
      $match: {
        companyId: req.user.companyId,
        projectId: new mongoose.Types.ObjectId(req.params.id),
      },
    },
    { $group: { _id: "$featureId", n: { $sum: 1 } } },
  ]).catch(() => []);
  const byFeature = new Map(counts.map((c) => [String(c._id), c.n]));

  res.json(
    features.map((f) => serializeFeature(f, byFeature.get(String(f._id)) || 0))
  );
}

async function createFeature(req, res) {
  if (!requireCompany(req, res)) return;
  const project = await E2eProject.findOne({
    _id: req.params.id,
    companyId: req.user.companyId,
  });
  if (!project) return res.status(404).json({ message: "Project not found" });

  const { name, description } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ message: "Feature name is required" });
  }
  const feature = await E2eFeature.create({
    userId: req.user._id,
    companyId: req.user.companyId,
    projectId: project._id,
    name: name.trim(),
    description: description || "",
  });
  res.status(201).json(serializeFeature(feature, 0));
}

async function deleteFeature(req, res) {
  if (!requireCompany(req, res)) return;
  const feature = await E2eFeature.findOneAndDelete({
    _id: req.params.featureId,
    companyId: req.user.companyId,
  });
  if (!feature) return res.status(404).json({ message: "Feature not found" });
  // Cascade: a feature's tests go with it.
  await E2eTest.deleteMany({
    featureId: feature._id,
    companyId: req.user.companyId,
  });
  res.json({ message: "Feature deleted" });
}

// ------------------- Feature 1: video → test cases -------------------

async function generateFromVideo(req, res) {
  if (!requireCompany(req, res)) return;
  if (!req.file) {
    return res.status(400).json({ message: "No video file uploaded (field 'video')" });
  }

  // Video is now dropped on a feature. Resolve the feature → its project so the
  // generated tests are tagged with both.
  const feature = await E2eFeature.findOne({
    _id: req.params.featureId,
    companyId: req.user.companyId,
  });
  if (!feature) return res.status(404).json({ message: "Feature not found" });

  try {
    const anthropicClient = await getUserAnthropicClient(req.user._id);
    const result = await e2eQaService.generateFromVideo({
      projectId: feature.projectId,
      featureId: feature._id,
      userId: req.user._id,
      companyId: req.user.companyId,
      buffer: req.file.buffer,
      filename: req.file.originalname,
      mimeType: req.file.mimetype,
      anthropicClient,
    });
    res.json(result);
  } catch (err) {
    const status = err.statusCode || 500;
    console.error("e2e generateFromVideo error:", err);
    res.status(status).json({ message: err.message || "Generation failed" });
  }
}

// ------------------------------- Tests -------------------------------

async function listTests(req, res) {
  if (!requireCompany(req, res)) return;
  // Feature-scoped when :featureId is on the route, else all of a project's
  // tests (kept for any caller still listing at the project level).
  const filter = { companyId: req.user.companyId };
  if (req.params.featureId) filter.featureId = req.params.featureId;
  else filter.projectId = req.params.id;
  const tests = await E2eTest.find(filter).sort({ createdAt: -1 });
  res.json(tests);
}

async function getTest(req, res) {
  if (!requireCompany(req, res)) return;
  const test = await E2eTest.findOne({
    _id: req.params.testId,
    companyId: req.user.companyId,
  });
  if (!test) return res.status(404).json({ message: "Test not found" });
  res.json(test);
}

// Gherkin is edited as ONE block of text, not as three lists: a real scenario
// interleaves its steps (When → Then → And → When …) and the given/when/then
// arrays can't hold that order. So the raw text is what we store and what the
// heal prompt reads; parseGherkinText keeps the structured view in sync for the
// readers that still want it.
const MAX_GHERKIN_LEN = 20000;
const TEST_KINDS = ["smoke", "regression", "bughunt"];

// Returns the { gherkinText, gherkin } pair to write for a submitted block of
// text. `fallbackFeature` names the Olivia feature, used only when the pasted
// text has no "Feature:" line of its own.
function gherkinFromText(text, fallbackFeature = "") {
  const gherkinText = String(text == null ? "" : text)
    .replace(/\r\n/g, "\n")
    .trim()
    .slice(0, MAX_GHERKIN_LEN);
  const gherkin = parseGherkinText(gherkinText);
  if (!gherkin.feature) gherkin.feature = fallbackFeature;
  return { gherkinText, gherkin };
}

// Write a test case by hand instead of getting it from a video. Same shape as a
// generated one (status "draft"), so it flows into record → improve → commit
// with no special-casing anywhere downstream.
async function createTest(req, res) {
  if (!requireCompany(req, res)) return;
  const feature = await E2eFeature.findOne({
    _id: req.params.featureId,
    companyId: req.user.companyId,
  });
  if (!feature) return res.status(404).json({ message: "Feature not found" });

  const { name, kind, gherkinText } = req.body;
  if (!name || !String(name).trim()) {
    return res.status(400).json({ message: "Test name is required" });
  }

  const test = await E2eTest.create({
    userId: req.user._id,
    companyId: req.user.companyId,
    projectId: feature.projectId,
    featureId: feature._id,
    name: String(name).trim().slice(0, 200),
    source: "manual",
    kind: TEST_KINDS.includes(kind) ? kind : "regression",
    ...gherkinFromText(gherkinText, feature.name),
    status: "draft",
  });
  res.status(201).json(test);
}

// Edit a case's name/kind/scenario — whether Claude wrote it from the video or
// the user did. Only those fields are touched: specCode, heal log, commit and
// status belong to the record/improve pipeline and are never overwritten from
// here (editing the steps after a spec exists just means the next Improve run
// has better instructions).
async function updateTest(req, res) {
  if (!requireCompany(req, res)) return;
  const test = await E2eTest.findOne({
    _id: req.params.testId,
    companyId: req.user.companyId,
  });
  if (!test) return res.status(404).json({ message: "Test not found" });

  const { name, kind, gherkinText } = req.body;
  if (name != null) {
    const trimmed = String(name).trim();
    if (!trimmed) return res.status(400).json({ message: "Test name is required" });
    test.name = trimmed.slice(0, 200);
  }
  if (kind != null) {
    if (!TEST_KINDS.includes(kind)) {
      return res.status(400).json({ message: `kind must be one of ${TEST_KINDS.join(", ")}` });
    }
    test.kind = kind;
  }
  if (gherkinText != null) {
    const parsed = gherkinFromText(gherkinText, test.gherkin?.feature || "");
    test.gherkinText = parsed.gherkinText;
    // Keep the scenario title the video gave it when the text has no header.
    if (!parsed.gherkin.scenario) parsed.gherkin.scenario = test.gherkin?.scenario || "";
    test.gherkin = parsed.gherkin;
  }
  test.updatedAt = new Date();
  await test.save();
  res.json(test);
}

// Feature 2 — one-time login capture. Launches the recorder at the login page;
// the user logs in by hand (handles SSO/2FA/whatever), and on close we save the
// authenticated session (storageState) for the project. Done ONCE — every test
// recording/run then starts already logged in.
async function recordLogin(req, res) {
  if (!requireCompany(req, res)) return;
  const project = await E2eProject.findOne({
    _id: req.params.id,
    companyId: req.user.companyId,
  });
  if (!project) return res.status(404).json({ message: "Project not found" });

  // Optional env: capture the session for that specific environment. Without
  // it we fall back to the legacy project-level login.
  const envName = req.body?.env;
  const target = resolveTarget(project, envName);
  if (envName && !target.env) {
    return res
      .status(400)
      .json({ message: `Environment "${envName}" not found on this project.` });
  }

  const base = (target.baseUrl || "").replace(/\/+$/, "");
  const startUrl = target.loginUrl || (base ? `${base}/login` : "");
  if (!startUrl) {
    return res.status(400).json({
      message: `Set a base URL (or login URL) for ${
        target.name || "this project"
      } first.`,
    });
  }

  const authFile = authPathFor(project._id, target.env ? target.name : undefined);
  try {
    // We only care about the captured session here, not the throwaway spec.
    await recordSpec(startUrl, { saveStorage: authFile, requireSpec: false });
    if (!fs.existsSync(authFile)) {
      return res.status(422).json({
        message: "No session was captured — did the login complete?",
      });
    }
    const savedAt = new Date();
    persistStorageState({ project, env: target.env }, authFile);
    if (target.env) {
      target.env.authSavedAt = savedAt;
      project.markModified("environments");
    } else {
      project.login.authSavedAt = savedAt;
    }
    project.updatedAt = new Date();
    await project.save();
    res.json({ authReady: true, authSavedAt: savedAt, env: target.name || null });
  } catch (err) {
    const status = err.statusCode || 500;
    console.error("e2e recordLogin error:", err);
    res.status(status).json({ message: err.message || "Login capture failed" });
  }
}

// Feature 2 — record a test flow. Opens the app at baseUrl ALREADY LOGGED IN
// (loads the project's saved session) so the user records only the real flow,
// never the login. Playwright writes the spec, which we save onto the test.
async function recordTest(req, res) {
  if (!requireCompany(req, res)) return;
  const test = await E2eTest.findOne({
    _id: req.params.testId,
    companyId: req.user.companyId,
  });
  if (!test) return res.status(404).json({ message: "Test not found" });

  const project = await E2eProject.findOne({
    _id: test.projectId,
    companyId: req.user.companyId,
  });
  if (!project) return res.status(404).json({ message: "Project not found" });

  const envName = req.body?.env;
  const target = resolveTarget(project, envName);
  if (envName && !target.env) {
    return res
      .status(400)
      .json({ message: `Environment "${envName}" not found on this project.` });
  }
  const url = target.baseUrl;
  if (!url) {
    return res.status(400).json({
      message: `Set a base URL for ${
        target.name || "this project"
      } before recording.`,
    });
  }

  // GATE: a recording on an unauthenticated session just lands on the login
  // page. Tell the front to capture the login for THIS environment first.
  const loadStorage = ensureStorageStateFile(project, target);
  if (!loadStorage) {
    return res.status(409).json({
      code: "LOGIN_REQUIRED",
      env: target.name || null,
      message: `Capture the login for ${
        target.name || "this project"
      } before recording, or the test will start logged out.`,
    });
  }

  try {
    if (target.env) project.markModified("environments");
    await project.save();
    const spec = await recordSpec(url, { loadStorage });
    test.specCode = spec;
    test.source = "recording";
    test.status = "draft";
    test.updatedAt = new Date();
    await test.save();
    res.json({ specCode: spec, status: test.status, loggedIn: Boolean(loadStorage) });
  } catch (err) {
    const status = err.statusCode || 500;
    console.error("e2e recordTest error:", err);
    res.status(status).json({ message: err.message || "Recording failed" });
  }
}

// Feature 3 — improve + self-heal. Takes the recorded spec (the UI movements),
// reads the front-end repo for reuse (helpers/page-objects/data-testids), has
// Claude rewrite it to senior quality (DRY, real selectors, assertions), then
// runs it locally and feeds failures back until it goes green (bounded). Returns
// the green spec; we persist specCode + heal[] + status (repo code is never
// stored — it's read at request time and discarded).
async function improveTest(req, res) {
  if (!requireCompany(req, res)) return;
  const test = await E2eTest.findOne({
    _id: req.params.testId,
    companyId: req.user.companyId,
  });
  if (!test) return res.status(404).json({ message: "Test not found" });
  if (!test.specCode || !test.specCode.trim()) {
    return res
      .status(400)
      .json({ message: "Record the test first — there's no spec to improve." });
  }

  const project = await E2eProject.findOne({
    _id: test.projectId,
    companyId: req.user.companyId,
  });
  if (!project) return res.status(404).json({ message: "Project not found" });

  const envName = req.body?.env;
  const target = resolveTarget(project, envName);
  if (envName && !target.env) {
    return res
      .status(400)
      .json({ message: `Environment "${envName}" not found on this project.` });
  }

  // Run already logged in. Same gate as recording — no session for this env
  // means the heal loop would chase failures caused by being logged out.
  const loadStorage = ensureStorageStateFile(project, target);
  if (!loadStorage) {
    return res.status(409).json({
      code: "LOGIN_REQUIRED",
      env: target.name || null,
      message: `Capture the login for ${
        target.name || "this project"
      } before improving this test.`,
    });
  }

  try {
    if (target.env) project.markModified("environments");
    await project.save();
    const anthropicClient = await getUserAnthropicClient(req.user._id);
    const result = await e2eHealService.improveAndHeal({
      test,
      project,
      storagePath: loadStorage,
      env: target.env ? { name: target.name, baseUrl: target.baseUrl } : undefined,
      anthropicClient,
    });

    test.specCode = result.specCode;
    test.heal = result.heal;
    test.status = result.passed ? "passing" : "failing";
    test.updatedAt = new Date();
    await test.save();

    res.json({
      specCode: test.specCode,
      status: test.status,
      passed: result.passed,
      heal: test.heal,
      repo: { files: result.repo?.files || 0, testIds: result.repo?.testIds || 0 },
    });
  } catch (err) {
    const status = err.statusCode || 500;
    console.error("e2e improveTest error:", err);
    res.status(status).json({ message: err.message || "Improve/heal failed" });
  }
}

// Feature 3 — commit & push. Writes the test's spec straight to the project's
// connected repo (branch from project.github.branch, else the repo default) via
// the GitHub App. The Contents API commits on the remote, so it's pushed and
// visible on GitHub instantly. Saves the commit (branch/sha/url) on the test.
async function commitTest(req, res) {
  if (!requireCompany(req, res)) return;
  const test = await E2eTest.findOne({
    _id: req.params.testId,
    companyId: req.user.companyId,
  });
  if (!test) return res.status(404).json({ message: "Test not found" });
  if (!test.specCode || !test.specCode.trim()) {
    return res
      .status(400)
      .json({ message: "Nothing to commit — record & improve the test first." });
  }

  const project = await E2eProject.findOne({
    _id: test.projectId,
    companyId: req.user.companyId,
  });
  if (!project) return res.status(404).json({ message: "Project not found" });

  const owner = project.github?.owner;
  const repo = project.github?.repo;
  if (!owner || !repo) {
    return res.status(400).json({
      message: "Connect a GitHub repo to this project before committing.",
    });
  }

  const octokit = await resolveOctokit(project);
  if (!octokit) {
    return res.status(409).json({
      message:
        "No GitHub App installation can write to this repo. Reconnect the repo.",
    });
  }

  try {
    const branch =
      project.github?.branch ||
      (await getDefaultBranch(octokit, owner, repo));
    const testDir = project.github?.testDir || "tests/e2e";
    // Reuse the test's stored path so re-commits update the same file.
    const filePath =
      test.specPath || `${testDir.replace(/\/+$/, "")}/${slugify(test.name)}.spec.ts`;

    const commit = await commitFileToBranch(octokit, {
      owner,
      repo,
      branch,
      path: filePath,
      content: test.specCode,
      message: `test(e2e): ${test.name}`,
    });

    test.specPath = filePath;
    test.commit = {
      branch: commit.branch,
      sha: commit.sha,
      url: commit.url,
      committedAt: new Date(),
    };
    test.status = "committed";
    test.updatedAt = new Date();
    await test.save();

    res.json({ status: test.status, commit: test.commit });
  } catch (err) {
    const status = err.status || err.statusCode || 500;
    console.error("e2e commitTest error:", err);
    res.status(status).json({ message: err.message || "Commit failed" });
  }
}

async function deleteTest(req, res) {
  if (!requireCompany(req, res)) return;
  const test = await E2eTest.findOneAndDelete({
    _id: req.params.testId,
    companyId: req.user.companyId,
  });
  if (!test) return res.status(404).json({ message: "Test not found" });
  res.json({ message: "Test deleted" });
}

// --- Cloud recorder (SaaS) -------------------------------------------------
// The customer records their flow in a Browserbase cloud browser driven from an
// embedded live view — no install, no changes to their app. Olivia injects the
// recorder + their logged-in session; events stream to ingest; on finish they
// become a Playwright spec that feeds the existing heal loop.

// Decrypted Playwright storageState JSON for a target (so the cloud session
// starts already logged in), or "" when no session was captured yet.
function getStorageStateJson(project, target) {
  const encrypted = target.env
    ? target.env.storageStateEncrypted
    : project.login?.storageStateEncrypted;
  if (encrypted) {
    const json = decrypt(encrypted);
    if (json) return json;
  }
  // Fall back to an on-disk session file if present (older captures).
  const p = target.storageStatePath;
  if (p && fs.existsSync(p)) {
    try {
      return fs.readFileSync(p, "utf8");
    } catch (_) {}
  }
  return "";
}

function ingestBaseUrl(req) {
  const base = process.env.E2E_INGEST_BASE_URL || process.env.PUBLIC_BACKEND_URL;
  if (base) return base.replace(/\/+$/, "");
  // Behind Render/proxies `trust proxy` is off, so req.protocol reports "http".
  // The recorder runs on the customer's HTTPS app, so an http ingest URL is
  // mixed-content and gets blocked — read the forwarded proto so we build an
  // https URL and events actually reach us.
  const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "https")
    .split(",")[0]
    .trim();
  return `${proto}://${req.get("host")}`;
}

async function startClientRecording(req, res) {
  if (!requireCompany(req, res)) return;
  const test = await E2eTest.findOne({
    _id: req.params.testId,
    companyId: req.user.companyId,
  });
  if (!test) return res.status(404).json({ message: "Test not found" });

  const project = await E2eProject.findOne({
    _id: test.projectId,
    companyId: req.user.companyId,
  });
  if (!project) return res.status(404).json({ message: "Project not found" });

  const envName = req.body?.env;
  const target = resolveTarget(project, envName);
  if (envName && !target.env) {
    return res.status(400).json({ message: `Environment "${envName}" not found on this project.` });
  }
  const startUrl = target.baseUrl;
  if (!startUrl) {
    return res.status(400).json({
      message: `Set a base URL for ${target.name || "this project"} before recording.`,
    });
  }

  const unreachable = unreachableFromCloud(startUrl);
  if (unreachable) {
    return res.status(400).json({ code: "URL_NOT_PUBLIC", message: unreachable });
  }

  const token = crypto.randomBytes(24).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const ingestEndpoint = `${ingestBaseUrl(req)}/api/e2e/recordings/ingest`;
  const storageStateJson = getStorageStateJson(project, target);
  console.log(`[e2e cloud-record] start test=${test._id} url=${startUrl} ingest=${ingestEndpoint} auth=${storageStateJson ? "yes" : "none"}`);

  try {
    const { browserbaseSessionId, liveViewUrl } = await browserbase.startSession({
      startUrl,
      token,
      ingestEndpoint,
      storageStateJson,
    });

    const session = await E2eRecordingSession.create({
      userId: req.user._id,
      companyId: req.user.companyId,
      projectId: project._id,
      testId: test._id,
      envName: target.name || "",
      tokenHash,
      browserbaseSessionId,
      liveViewUrl,
      status: "recording",
    });

    res.status(201).json({
      recordingId: session._id,
      liveViewUrl,
      authReady: target.authReady,
    });
  } catch (err) {
    console.error("e2e startClientRecording error:", err);
    res.status(500).json({ message: err.message || "Could not start cloud recording" });
  }
}

// Public: the injected recorder POSTs one event per call from inside the cloud
// browser. Authenticated by the per-session token, not the user's cookie. Body
// arrives as text/plain (CORS-simple) so we parse it ourselves.
async function ingestClientRecording(req, res) {
  // Always answer fast; the recorder ignores the response body.
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    let body = req.body;
    if (typeof body === "string") {
      body = body ? JSON.parse(body) : {};
    } else if (Buffer.isBuffer(body)) {
      body = JSON.parse(body.toString("utf8") || "{}");
    }
    const token = body?.token;
    if (!token) return res.status(204).end();

    const tokenHash = crypto.createHash("sha256").update(String(token)).digest("hex");
    const now = new Date();
    const result = await E2eRecordingSession.updateOne(
      { tokenHash, status: "recording", kind: "recording" },
      {
        $push: {
          events: {
            type: body.type,
            url: body.url || "",
            title: body.title || "",
            selector: body.selector || "",
            testId: body.testId || null,
            role: body.role || "",
            text: body.text || "",
            value: body.value || "",
            sensitive: Boolean(body.sensitive),
            ts: Number(body.ts) || now.getTime(),
          },
        },
        $set: { lastEventAt: now },
      }
    );
    console.log(`[e2e ingest] type=${body.type} sel=${body.selector || body.testId || "?"} matched=${result.matchedCount}`);
    return res.status(204).end();
  } catch (err) {
    console.error("e2e ingestClientRecording error:", err.message);
    return res.status(204).end(); // never break the recorder
  }
}

// How long the login browser stays alive waiting for the human. Generous on
// purpose: an abandoned session costs one idle cloud browser until it expires,
// while a session that dies mid-login costs the customer the whole capture.
const LOGIN_SESSION_TIMEOUT_SECONDS = 15 * 60;

// --- Cloud login capture -----------------------------------------------------
// Same embedded browser as the cloud recorder, used to capture the project's
// authenticated session instead of a flow. This replaces recordLogin() for
// production: recordLogin spawns Playwright's codegen on the SERVER, so it can
// only ever open a window when the backend runs on the user's own machine —
// on Render there's no display and nothing opens. Here the browser lives in
// Browserbase and the customer drives it from the iframe, so it works the same
// locally and in production.
//
// Two deliberate differences from startClientRecording:
//   - no recorder injected: we are not streaming keystrokes off a password field
//   - no seeded session: a fresh login is the entire point
async function startCloudLogin(req, res) {
  if (!requireCompany(req, res)) return;
  const project = await E2eProject.findOne({
    _id: req.params.id,
    companyId: req.user.companyId,
  });
  if (!project) return res.status(404).json({ message: "Project not found" });

  const envName = req.body?.env;
  const target = resolveTarget(project, envName);
  if (envName && !target.env) {
    return res
      .status(400)
      .json({ message: `Environment "${envName}" not found on this project.` });
  }

  const base = (target.baseUrl || "").replace(/\/+$/, "");
  const startUrl = target.loginUrl || (base ? `${base}/login` : "");
  if (!startUrl) {
    return res.status(400).json({
      message: `Set a base URL (or login URL) for ${
        target.name || "this project"
      } first.`,
    });
  }

  const unreachable = unreachableFromCloud(startUrl);
  if (unreachable) {
    return res.status(400).json({ code: "URL_NOT_PUBLIC", message: unreachable });
  }

  console.log(`[e2e cloud-login] start project=${project._id} env=${target.name || "-"} url=${startUrl}`);

  try {
    const { browserbaseSessionId, liveViewUrl } = await browserbase.startSession({
      startUrl,
      injectRecorder: false,
      storageStateJson: "",
      // A person has to type credentials here, maybe through SSO and 2FA. The
      // 5-minute project default kills the browser mid-login.
      timeoutSeconds: LOGIN_SESSION_TIMEOUT_SECONDS,
    });

    const session = await E2eRecordingSession.create({
      userId: req.user._id,
      companyId: req.user.companyId,
      projectId: project._id,
      kind: "login",
      envName: target.name || "",
      // Unused for a login (nothing posts to /ingest), but the column is
      // unique+required, so give it a value that can never collide.
      tokenHash: crypto.randomBytes(32).toString("hex"),
      browserbaseSessionId,
      liveViewUrl,
      status: "recording",
    });

    res.status(201).json({
      recordingId: session._id,
      liveViewUrl,
      startUrl,
      env: target.name || null,
    });
  } catch (err) {
    console.error("e2e startCloudLogin error:", err);
    res
      .status(500)
      .json({ message: err.message || "Could not start the cloud login" });
  }
}

// Read the session out of the cloud browser and save it as the project's (or
// environment's) login. From here on every recording and run starts already
// logged in — the customer does this ONCE.
async function finishCloudLogin(req, res) {
  if (!requireCompany(req, res)) return;
  const session = await E2eRecordingSession.findOne({
    _id: req.params.recordingId,
    companyId: req.user.companyId,
    kind: "login",
  });
  if (!session) return res.status(404).json({ message: "Login session not found" });

  const project = await E2eProject.findOne({
    _id: session.projectId,
    companyId: req.user.companyId,
  });

  // Capture BEFORE teardown — finishSession closes the CDP connection and the
  // session becomes unreadable. Teardown still runs either way so we never
  // strand a paid cloud browser.
  const json = await browserbase.captureStorageState(session.browserbaseSessionId);
  await browserbase.finishSession(session.browserbaseSessionId).catch((err) =>
    console.error("e2e cloud-login teardown error:", err.message)
  );

  session.status = json ? "finished" : "error";
  session.finishedAt = new Date();
  await session.save();

  if (!project) return res.status(404).json({ message: "Project not found" });

  if (!json) {
    return res.status(422).json({
      message:
        "We lost the connection to the login browser before the session could be saved. Please try again.",
    });
  }

  // A browser that was never logged into still returns a well-formed but empty
  // storageState. Saving that would leave the project looking authenticated
  // while every run silently lands on the login page — reject it instead.
  let parsed = null;
  try {
    parsed = JSON.parse(json);
  } catch (_) {}
  const hasCookies = (parsed?.cookies || []).length > 0;
  const hasLocalStorage = (parsed?.origins || []).some(
    (o) => (o.localStorage || []).length > 0
  );
  if (!hasCookies && !hasLocalStorage) {
    return res.status(422).json({
      message:
        "No session was captured — log in inside the browser window before clicking Finish.",
    });
  }

  const target = resolveTarget(project, session.envName);
  const savedAt = new Date();
  const authFile = authPathFor(project._id, target.env ? target.name : undefined);
  persistStorageStateJson({ project, env: target.env }, json, authFile);
  if (target.env) {
    target.env.authSavedAt = savedAt;
    project.markModified("environments");
  } else {
    project.login.authSavedAt = savedAt;
  }
  project.updatedAt = new Date();
  await project.save();

  console.log(`[e2e cloud-login] saved project=${project._id} env=${target.name || "-"} cookies=${(parsed?.cookies || []).length}`);

  res.json({ authReady: true, authSavedAt: savedAt, env: target.name || null });
}

async function finishClientRecording(req, res) {
  if (!requireCompany(req, res)) return;
  const session = await E2eRecordingSession.findOne({
    _id: req.params.recordingId,
    companyId: req.user.companyId,
  });
  if (!session) return res.status(404).json({ message: "Recording session not found" });

  // Tear down the cloud browser regardless of what happens next.
  await browserbase.finishSession(session.browserbaseSessionId).catch((err) =>
    console.error("e2e finishSession teardown error:", err.message)
  );

  const test = await E2eTest.findOne({
    _id: session.testId,
    companyId: req.user.companyId,
  });
  if (!test) {
    session.status = "finished";
    session.finishedAt = new Date();
    await session.save();
    return res.status(404).json({ message: "Test not found" });
  }

  const specCode = actionsToPlaywrightSpec({
    title: test.name || test.gherkin?.scenario || "recorded flow",
    actions: session.events || [],
  });

  test.specCode = specCode;
  test.source = "cloud-recording";
  test.status = "draft";
  test.updatedAt = new Date();
  await test.save();

  session.status = "finished";
  session.finishedAt = new Date();
  await session.save();

  res.json({
    specCode,
    eventCount: (session.events || []).length,
    status: test.status,
  });
}

module.exports = {
  listProjects,
  createProject,
  getProject,
  updateProject,
  deleteProject,
  listFeatures,
  createFeature,
  deleteFeature,
  generateFromVideo,
  listTests,
  getTest,
  createTest,
  updateTest,
  recordLogin,
  recordTest,
  improveTest,
  commitTest,
  deleteTest,
  startClientRecording,
  ingestClientRecording,
  finishClientRecording,
  startCloudLogin,
  finishCloudLogin,
};
