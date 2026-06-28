const fs = require("fs");
const path = require("path");
const E2eProject = require("../model/E2eProject");
const E2eTest = require("../model/E2eTest");
const e2eQaService = require("../services/e2eQaService");
const e2eHealService = require("../services/e2eHealService");
const { recordSpec } = require("../services/e2eRecorderService");
const { encrypt, decrypt, maskSecret } = require("../services/secretCrypto");
const { getUserAnthropicClient } = require("../services/userKeyService");

// Where the per-project authenticated Playwright session lives. Gitignored —
// it holds live session cookies. (Productized: encrypt + store in S3.)
const AUTH_DIR = path.resolve(__dirname, "../.e2e-auth");
function authPathFor(projectId, env) {
  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
  // No env → legacy single-session path (keeps already-captured sessions valid).
  const suffix = env ? `__${String(env).replace(/[^a-z0-9_-]/gi, "_")}` : "";
  return path.join(AUTH_DIR, `${projectId}${suffix}.json`);
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
    env: null,
    name: "",
    baseUrl: project.baseUrl || "",
    loginUrl: project.login?.url || "",
    storageStatePath: project.login?.storageStatePath || "",
    authReady: Boolean(project.login?.authSavedAt),
  };
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
  await E2eTest.deleteMany({
    projectId: project._id,
    companyId: req.user.companyId,
  });
  res.json({ message: "Project deleted" });
}

// ------------------- Feature 1: video → test cases -------------------

async function generateFromVideo(req, res) {
  if (!requireCompany(req, res)) return;
  if (!req.file) {
    return res.status(400).json({ message: "No video file uploaded (field 'video')" });
  }
  try {
    const anthropicClient = await getUserAnthropicClient(req.user._id);
    const result = await e2eQaService.generateFromVideo({
      projectId: req.params.id,
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
  const tests = await E2eTest.find({
    companyId: req.user.companyId,
    projectId: req.params.id,
  }).sort({ createdAt: -1 });
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
    if (target.env) {
      target.env.storageStatePath = authFile;
      target.env.authSavedAt = savedAt;
      project.markModified("environments");
    } else {
      project.login.storageStatePath = authFile;
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
  const storagePath = target.storageStatePath;
  const loadStorage =
    storagePath && fs.existsSync(storagePath) ? storagePath : undefined;
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
  const storagePath = target.storageStatePath;
  const loadStorage =
    storagePath && fs.existsSync(storagePath) ? storagePath : undefined;
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

async function deleteTest(req, res) {
  if (!requireCompany(req, res)) return;
  const test = await E2eTest.findOneAndDelete({
    _id: req.params.testId,
    companyId: req.user.companyId,
  });
  if (!test) return res.status(404).json({ message: "Test not found" });
  res.json({ message: "Test deleted" });
}

module.exports = {
  listProjects,
  createProject,
  getProject,
  updateProject,
  deleteProject,
  generateFromVideo,
  listTests,
  getTest,
  recordLogin,
  recordTest,
  improveTest,
  deleteTest,
};
