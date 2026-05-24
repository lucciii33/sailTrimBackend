const McpProject = require("../model/McpProjectModel.js");
const McpTool = require("../model/McpToolModel.js");
const McpDoc = require("../model/McpDocModel.js");
const McpBug = require("../model/McpBugModel.js");
const mcpLab = require("./mcpLabService.js");
const mcpDocsLazy = () => require("./mcpDocService.js");
const { encrypt, decrypt } = require("./secretCrypto");

const SECRET_KEYS = new Set([
  "authorization",
  "bearerToken",
  "apiKey",
  "api_key",
  "token",
  "accessToken",
  "access_token",
  "refreshToken",
  "refresh_token",
  "clientSecret",
  "client_secret",
  "secret",
  "password",
]);

function isSecretKey(key = "") {
  return SECRET_KEYS.has(key) || /token|secret|password|api[-_]?key/i.test(key);
}

function maskUrlSecrets(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") return rawUrl;
  try {
    const parsed = new URL(rawUrl);
    for (const key of [...parsed.searchParams.keys()]) {
      if (/api[-_]?key|access[-_]?token|token|secret|password|bearer|auth/i.test(key)) {
        parsed.searchParams.set(key, "***encrypted***");
      }
    }
    return parsed.toString();
  } catch (_) {
    return rawUrl;
  }
}

const publicServerUrl = maskUrlSecrets;

function sanitizeConfig(value, parentKey = "") {
  if (Array.isArray(value)) return value.map((v) => sanitizeConfig(v));
  if (value && typeof value === "object") {
    return Object.entries(value).reduce((acc, [key, child]) => {
      acc[key] = isSecretKey(key) ? "***encrypted***" : sanitizeConfig(child, key);
      return acc;
    }, {});
  }
  if (parentKey === "url" && typeof value === "string") {
    return maskUrlSecrets(value);
  }
  return value;
}

function encryptConfig(config) {
  return encrypt(JSON.stringify(config || {}));
}

function decryptConfig(project) {
  if (project?.configEncrypted) {
    const raw = decrypt(project.configEncrypted);
    return raw ? JSON.parse(raw) : {};
  }
  return project?.config || {};
}

async function decryptAndMigrateConfig(project) {
  if (project?.configEncrypted) return decryptConfig(project);

  const legacyConfig = project?.config || {};
  if (project) {
    project.config = sanitizeConfig(legacyConfig);
    project.configEncrypted = encryptConfig(legacyConfig);
    await project.save();
  }
  return legacyConfig;
}

async function upsertProjectTools({ project, tools, suggestedArgsByTool = {}, userId, companyId }) {
  if (!tools?.length) {
    await McpTool.deleteMany({ projectId: project._id });
    return [];
  }

  const now = new Date();
  const ops = tools.map((tool) => {
    const suggested = suggestedArgsByTool[tool.name];
    const set = {
      projectId: project._id,
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      rawTool: tool,
      userId,
      companyId,
      updatedAt: now,
    };
    if (suggested && typeof suggested === "object") {
      set.suggestedArgs = suggested;
      set.suggestedArgsGeneratedAt = now;
    }
    return {
      updateOne: {
        filter: { projectId: project._id, name: tool.name },
        update: { $set: set },
        upsert: true,
      },
    };
  });

  await McpTool.bulkWrite(ops);
  await McpTool.deleteMany({
    projectId: project._id,
    name: { $nin: tools.map((tool) => tool.name) },
  });
  return McpTool.find({ projectId: project._id }).sort({ name: 1 });
}

async function saveProject({
  projectName,
  config,
  userId,
  companyId,
  provider = "anthropic",
  model,
  anthropicClient = null,
}) {
  if (!projectName) throw new Error("projectName required");
  if (!companyId) throw new Error("companyId required");
  const [tools, resources, prompts] = await Promise.all([
    mcpLab.listTools(config),
    mcpLab.listResources(config).catch(() => []),
    mcpLab.listPrompts(config).catch(() => []),
  ]);

  const { suggestSampleArgs } = mcpDocsLazy();
  let argsUsage = { inputTokens: 0, outputTokens: 0, model: null };
  const argSuggestions = await Promise.all(
    (tools || []).map(async (tool) => {
      const out = await suggestSampleArgs({ tool, provider, model, anthropicClient }).catch(() => null);
      if (out?.usage) {
        argsUsage.inputTokens += out.usage.inputTokens || 0;
        argsUsage.outputTokens += out.usage.outputTokens || 0;
        argsUsage.model = out.usage.model || argsUsage.model;
      }
      return { toolName: tool.name, args: out?.args || null };
    })
  );
  const suggestedArgsByTool = argSuggestions.reduce((acc, item) => {
    if (item.args) acc[item.toolName] = item.args;
    return acc;
  }, {});

  const project = await McpProject.findOneAndUpdate(
    { companyId, projectName },
    {
      $set: {
        projectName,
        name: projectName,
        config: sanitizeConfig(config),
        configEncrypted: encryptConfig(config),
        resources,
        prompts,
        lastConnectedAt: new Date(),
        userId,
        companyId,
      },
    },
    { new: true, upsert: true }
  );
  const projectTools = await upsertProjectTools({
    project,
    tools,
    suggestedArgsByTool,
    userId,
    companyId,
  });

  return { project, config, tools: projectTools, resources, prompts, argsUsage };
}

async function getProject({ projectId, companyId }) {
  const q = { _id: projectId };
  if (companyId) q.companyId = companyId;
  const project = await McpProject.findOne(q);
  if (!project) throw new Error("MCP project not found");
  if (project.config) {
    const sanitized = sanitizeConfig(project.config);
    if (JSON.stringify(sanitized) !== JSON.stringify(project.config)) {
      project.config = sanitized;
      await project.save();
    }
  }
  return project;
}

async function getProjectOverview({ projectId, companyId }) {
  const project = await getProject({ projectId, companyId });
  const q = { projectId: project._id };
  if (companyId) q.companyId = companyId;
  const [tools, docs, bugs] = await Promise.all([
    McpTool.find(q).sort({ name: 1 }),
    McpDoc.find(q).sort({ updatedAt: -1 }),
    McpBug.find(q).sort({ createdAt: -1 }),
  ]);
  const toolsWithBugs = tools.map((tool) => ({
    ...tool.toObject(),
    bugs: bugs.filter((bug) => bug.toolName === tool.name),
  }));
  return { project, tools: toolsWithBugs, docs, bugs };
}

async function resolveConfig({ projectId, config, companyId }) {
  if (!projectId) return { project: null, config };
  const project = await getProject({ projectId, companyId });
  return { project, config: await decryptAndMigrateConfig(project) };
}

async function listProjects({ companyId }) {
  const q = {};
  if (companyId) q.companyId = companyId;
  const projects = await McpProject.find(q).sort({ updatedAt: -1 });
  for (const project of projects) {
    if (project.config) {
      const sanitized = sanitizeConfig(project.config);
      if (JSON.stringify(sanitized) !== JSON.stringify(project.config)) {
        project.config = sanitized;
        await project.save();
      }
    }
  }
  return projects;
}

async function listProjectTools({ projectId, companyId }) {
  const q = { projectId };
  if (companyId) q.companyId = companyId;
  return McpTool.find(q).sort({ name: 1 });
}

module.exports = {
  saveProject,
  getProject,
  getProjectOverview,
  resolveConfig,
  listProjects,
  listProjectTools,
  decryptConfig,
  publicServerUrl,
};
