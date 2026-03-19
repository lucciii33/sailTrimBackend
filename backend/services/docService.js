const OpenAI = require("openai");
const Doc = require("../model/DocModel");

const openai = new OpenAI({ apiKey: process.env.OPEN_IA });

async function generateAndSaveDocs(diff, prNumber, repo, owner) {
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
      "description": "Brief description of what this endpoint does",
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
      update: { $set: { ...ep, prNumber, repo, owner } },
      upsert: true,
    },
  }));

  await Doc.bulkWrite(ops);

  return endpoints;
}

module.exports = { generateAndSaveDocs };
