const McpProject = require("../model/McpProjectModel.js");
const McpTool = require("../model/McpToolModel.js");
const McpDoc = require("../model/McpDocModel.js");
const McpBug = require("../model/McpBugModel.js");
const mcpLab = require("./mcpLabService.js");

async function upsertProjectTools({ project, tools, userId, companyId }) {
  if (!tools?.length) {
    await McpTool.deleteMany({ projectId: project._id });
    return [];
  }

  const ops = tools.map((tool) => ({
    updateOne: {
      filter: { projectId: project._id, name: tool.name },
      update: {
        $set: {
          projectId: project._id,
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          outputSchema: tool.outputSchema,
          rawTool: tool,
          userId,
          companyId,
          updatedAt: new Date(),
        },
      },
      upsert: true,
    },
  }));

  await McpTool.bulkWrite(ops);
  await McpTool.deleteMany({
    projectId: project._id,
    name: { $nin: tools.map((tool) => tool.name) },
  });
  return McpTool.find({ projectId: project._id }).sort({ name: 1 });
}

async function saveProject({ projectName, config, userId, companyId }) {
  if (!projectName) throw new Error("projectName required");
  if (!companyId) throw new Error("companyId required");
  const [tools, resources, prompts] = await Promise.all([
    mcpLab.listTools(config),
    mcpLab.listResources(config).catch(() => []),
    mcpLab.listPrompts(config).catch(() => []),
  ]);

  const project = await McpProject.findOneAndUpdate(
    { companyId, projectName },
    {
      $set: {
        projectName,
        name: projectName,
        config,
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
    userId,
    companyId,
  });

  return { project, tools: projectTools, resources, prompts };
}

async function getProject({ projectId, companyId }) {
  const q = { _id: projectId };
  if (companyId) q.companyId = companyId;
  const project = await McpProject.findOne(q);
  if (!project) throw new Error("MCP project not found");
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
  return { project, config: project.config };
}

async function listProjects({ companyId }) {
  const q = {};
  if (companyId) q.companyId = companyId;
  return McpProject.find(q).sort({ updatedAt: -1 });
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
};
