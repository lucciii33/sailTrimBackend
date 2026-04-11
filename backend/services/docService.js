const OpenAI = require("openai");
const Doc = require("../model/DocModel");

const openai = new OpenAI({ apiKey: process.env.OPEN_IA });

async function generateAndSaveDocs(diff, prNumber, repo, owner, userId) {
  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You are an API documentation generator. Given a code diff, detect any new or modified API endpoints and return structured documentation for them.

Return a JSON object with this exact shape:
{
  "endpoints": [
    {
      "method": "POST",
      "path": "/api/example",
      "description": "Deep description of what this endpoint does",
      "requestBody": [
        { "name": "fieldName", "type": "String", "required": true, "description": "what it is" }
      ],
      "queryParams": [
        { "name": "paramName", "type": "String", "required": false, "description": "what it is" }
      ],
      "responses": [
        { "status": 200, "description": "Success description", "example": { "key": "value" } },
        { "status": 400, "description": "Error description", "example": { "message": "error" } }
      ]
    }
  ]
}

If no API endpoints are added or modified, return { "endpoints": [] }.
Only document routes defined with express router methods (get, post, put, delete, patch).`,
      },
      {
        role: "user",
        content: `Generate API documentation for the following code diff:\n\n${diff}`,
      },
    ],
  });

  const parsed = JSON.parse(completion.choices[0].message.content);
  const endpoints = parsed.endpoints || [];

  if (endpoints.length === 0) return [];

  const ops = endpoints.map((ep) => ({
    updateOne: {
      filter: { method: ep.method, path: ep.path, repo, owner },
      update: { $set: { ...ep, prNumber, repo, owner, userId } },
      upsert: true,
    },
  }));

  await Doc.bulkWrite(ops);

  return endpoints;
}

async function generateDocsFromFile({ filePath, content }) {
  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You are an API documentation generator. Given a source file, detect every HTTP API endpoint defined in it and return structured documentation.

Return a JSON object with this exact shape:
{
  "endpoints": [
    {
      "method": "POST",
      "path": "/api/example",
      "description": "Deep description of what this endpoint does",
      "requestBody": [
        { "name": "fieldName", "type": "String", "required": true, "description": "what it is" }
      ],
      "queryParams": [
        { "name": "paramName", "type": "String", "required": false, "description": "what it is" }
      ],
      "responses": [
        { "status": 200, "description": "Success description", "example": { "key": "value" } },
        { "status": 400, "description": "Error description", "example": { "message": "error" } }
      ]
    }
  ]
}

If no API endpoints are defined, return { "endpoints": [] }.
Only document routes defined with HTTP verb handlers (express router/app .get/.post/.put/.patch/.delete, fastify, NestJS @Get/@Post decorators, etc.).
Infer the full URL path when possible. If the file only mounts a sub-router with a prefix, still document each endpoint with its relative path.`,
      },
      {
        role: "user",
        content: `File: ${filePath}\n\n\`\`\`\n${content}\n\`\`\``,
      },
    ],
  });

  const parsed = JSON.parse(completion.choices[0].message.content);
  return parsed.endpoints || [];
}

async function saveBackfillDocs({
  endpoints,
  repo,
  owner,
  userId,
  sourceFile,
  sourceSha,
}) {
  if (!endpoints.length) return 0;

  const ops = endpoints.map((ep) => ({
    updateOne: {
      filter: { method: ep.method, path: ep.path, repo, owner },
      update: {
        $set: {
          ...ep,
          repo,
          owner,
          userId,
          source: "backfill",
          sourceFile,
          sourceSha,
          updatedAt: new Date(),
        },
      },
      upsert: true,
    },
  }));

  await Doc.bulkWrite(ops);
  return endpoints.length;
}

module.exports = { generateAndSaveDocs, generateDocsFromFile, saveBackfillDocs };
