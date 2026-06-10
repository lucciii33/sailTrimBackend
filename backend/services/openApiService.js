const yaml = require("js-yaml");
const Doc = require("../model/DocModel");
const ApiProject = require("../model/ApiProject");

// ---------------------------------------------------------------------------
// OpenAPI / Swagger → Doc adapter
//
// One engine, two ways to feed it (GitHub file or pasted text). It turns a
// spec into the SAME Doc shape the rest of the QA pipeline already consumes,
// so findBugs / test generation work unchanged.
//
// Re-importing is an UPSERT keyed on (method, path, owner, repo): a spec with
// one extra endpoint adds one Doc, updates the rest in place, and leaves bug /
// regression history (keyed on the doc) untouched.
// ---------------------------------------------------------------------------

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];
const MAX_REF_DEPTH = 6;

// ---------- parsing ----------

function parseSpec(specText) {
  if (!specText || !specText.trim()) {
    const err = new Error("Empty spec");
    err.statusCode = 400;
    throw err;
  }
  let spec;
  try {
    spec = JSON.parse(specText); // JSON is valid YAML, but this is faster + clearer
  } catch (_) {
    try {
      spec = yaml.load(specText);
    } catch (e) {
      const err = new Error(`Could not parse spec as JSON or YAML: ${e.message}`);
      err.statusCode = 400;
      throw err;
    }
  }
  if (!spec || typeof spec !== "object") {
    const err = new Error("Spec did not parse to an object");
    err.statusCode = 400;
    throw err;
  }
  if (!spec.openapi && !spec.swagger) {
    const err = new Error("Not an OpenAPI/Swagger spec (missing 'openapi' or 'swagger' key)");
    err.statusCode = 400;
    throw err;
  }
  return spec;
}

// ---------- $ref resolution ----------

function resolveRef(ref, spec) {
  // ref looks like "#/components/schemas/Pet" or "#/definitions/Pet"
  if (typeof ref !== "string" || !ref.startsWith("#/")) return null;
  const parts = ref.slice(2).split("/");
  let node = spec;
  for (const p of parts) {
    if (node == null) return null;
    node = node[decodeURIComponent(p.replace(/~1/g, "/").replace(/~0/g, "~"))];
  }
  return node || null;
}

// Collapse $ref + allOf into a plain schema object (shallow-ish, depth-limited).
function deref(schema, spec, depth = 0) {
  if (!schema || typeof schema !== "object" || depth > MAX_REF_DEPTH) return schema || {};
  if (schema.$ref) {
    const resolved = resolveRef(schema.$ref, spec);
    return deref(resolved, spec, depth + 1);
  }
  if (Array.isArray(schema.allOf)) {
    const merged = { type: "object", properties: {}, required: [] };
    for (const part of schema.allOf) {
      const d = deref(part, spec, depth + 1);
      Object.assign(merged.properties, d.properties || {});
      if (Array.isArray(d.required)) merged.required.push(...d.required);
    }
    return merged;
  }
  return schema;
}

// ---------- type + example helpers ----------

function typeLabel(schema) {
  if (!schema) return "Object";
  if (schema.type === "integer" || schema.type === "number") return "Number";
  if (schema.type === "boolean") return "Boolean";
  if (schema.type === "array") return "Array";
  if (schema.type === "object" || schema.properties) return "Object";
  if (schema.type === "string") return "String";
  return schema.type ? schema.type[0].toUpperCase() + schema.type.slice(1) : "Object";
}

// Flatten an object schema into [{name,type,required,description}], walking
// nested objects with dotted names and arrays as "field[].sub".
function schemaToParams(schema, spec, prefix = "", depth = 0, out = []) {
  const s = deref(schema, spec, depth);
  if (!s || depth > MAX_REF_DEPTH) return out;
  const props = s.properties || {};
  const requiredSet = new Set(s.required || []);

  for (const [name, rawChild] of Object.entries(props)) {
    const child = deref(rawChild, spec, depth);
    const fullName = prefix ? `${prefix}.${name}` : name;
    out.push({
      name: fullName,
      type: typeLabel(child),
      required: requiredSet.has(name),
      description: child.description || "",
    });
    if ((child.type === "object" || child.properties) && depth < MAX_REF_DEPTH) {
      schemaToParams(child, spec, fullName, depth + 1, out);
    } else if (child.type === "array" && child.items) {
      const item = deref(child.items, spec, depth);
      if (item.type === "object" || item.properties) {
        schemaToParams(item, spec, `${fullName}[]`, depth + 1, out);
      }
    }
  }
  return out;
}

function sampleFromSchema(schema, spec, depth = 0) {
  const s = deref(schema, spec, depth);
  if (!s || depth > MAX_REF_DEPTH) return null;
  if (s.example !== undefined) return s.example;
  if (s.default !== undefined) return s.default;
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];

  switch (s.type) {
    case "integer":
    case "number":
      return 0;
    case "boolean":
      return true;
    case "string":
      return s.format === "date-time" ? new Date().toISOString() : "string";
    case "array":
      return [sampleFromSchema(s.items || {}, spec, depth + 1)].filter((v) => v !== null);
    case "object":
    default: {
      if (!s.properties) return {};
      const obj = {};
      for (const [k, v] of Object.entries(s.properties)) {
        obj[k] = sampleFromSchema(v, spec, depth + 1);
      }
      return obj;
    }
  }
}

// ---------- request body / params per operation ----------

function bodySchemaForOp(op, spec) {
  // OpenAPI 3: requestBody.content['application/json'].schema
  if (op.requestBody) {
    const rb = deref(op.requestBody, spec);
    const content = rb.content || {};
    const json =
      content["application/json"] ||
      content["application/*+json"] ||
      Object.values(content)[0];
    if (json && json.schema) return deref(json.schema, spec);
  }
  // Swagger 2: a parameter with in:"body"
  const params = op.parameters || [];
  const bodyParam = params.find((p) => p.in === "body");
  if (bodyParam && bodyParam.schema) return deref(bodyParam.schema, spec);
  return null;
}

function queryParamsForOp(op, spec, pathLevelParams) {
  const all = [...(pathLevelParams || []), ...(op.parameters || [])].map((p) =>
    p.$ref ? resolveRef(p.$ref, spec) : p
  );
  return all
    .filter((p) => p && p.in === "query")
    .map((p) => ({
      name: p.name,
      // Swagger 2 puts type on the param; OpenAPI 3 nests it under schema.
      type: typeLabel(p.schema || p),
      required: Boolean(p.required),
      description: p.description || "",
    }));
}

function responsesForOp(op, spec) {
  const out = [];
  const responses = op.responses || {};
  for (const [code, rawResp] of Object.entries(responses)) {
    if (code === "default") continue;
    const resp = deref(rawResp, spec);
    let example = null;
    // OpenAPI 3
    if (resp.content) {
      const json =
        resp.content["application/json"] || Object.values(resp.content)[0];
      if (json) {
        example =
          json.example ??
          (json.examples && Object.values(json.examples)[0]?.value) ??
          (json.schema ? sampleFromSchema(json.schema, spec) : null);
      }
    } else if (resp.schema) {
      // Swagger 2
      example = sampleFromSchema(resp.schema, spec);
    }
    out.push({
      status: parseInt(code, 10) || 0,
      description: resp.description || "",
      example: example ?? {},
    });
  }
  return out;
}

// ---------- spec → endpoints ----------

// Group key for an operation: prefer the swagger tag, else derive from path.
function sectionFor(op, rawPath) {
  if (Array.isArray(op.tags) && op.tags.length && op.tags[0]) {
    return String(op.tags[0]);
  }
  // Fallback: skip /api and version segments, take the first real noun.
  const segs = rawPath.split("/").filter(Boolean);
  const meaningful = segs.find(
    (s) => !/^(api|v\d+)$/i.test(s) && !s.startsWith("{") && !s.startsWith(":")
  );
  return meaningful ? meaningful : "default";
}

function specToEndpoints(spec) {
  const endpoints = [];
  const paths = spec.paths || {};
  for (const [rawPath, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== "object") continue;
    const pathLevelParams = pathItem.parameters || [];
    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op || typeof op !== "object") continue;

      const bodySchema = bodySchemaForOp(op, spec);
      endpoints.push({
        method: method.toUpperCase(),
        path: rawPath,
        section: sectionFor(op, rawPath),
        description:
          op.summary || op.description || op.operationId || `${method.toUpperCase()} ${rawPath}`,
        requestBody: bodySchema ? schemaToParams(bodySchema, spec) : [],
        queryParams: queryParamsForOp(op, spec, pathLevelParams),
        responses: responsesForOp(op, spec),
      });
    }
  }
  return endpoints;
}

// ---------- base URL ----------

function extractBaseUrl(spec) {
  // OpenAPI 3
  if (Array.isArray(spec.servers) && spec.servers.length && spec.servers[0].url) {
    return spec.servers[0].url;
  }
  // Swagger 2
  if (spec.host) {
    const scheme = (spec.schemes && spec.schemes[0]) || "https";
    return `${scheme}://${spec.host}${spec.basePath || ""}`;
  }
  return null;
}

// ---------- auth detection (from securitySchemes) ----------

// Extract OAuth2 tokenUrl from any flow in a securityScheme entry.
function extractTokenUrl(scheme) {
  const flows = scheme.flows || {};
  // clientCredentials is most common for machine-to-machine APIs
  for (const flow of ["clientCredentials", "password", "authorizationCode", "implicit"]) {
    if (flows[flow]?.tokenUrl) return flows[flow].tokenUrl;
  }
  // Swagger 2: tokenUrl is directly on the scheme
  if (scheme.tokenUrl) return scheme.tokenUrl;
  return null;
}

// Read what KIND of auth the spec declares (never the secret value — that's
// never in a spec) and map it to our auth config shape.
// Also returns tokenUrl (for OAuth2) and requiredVariables the user must still provide.
function detectAuth(spec) {
  // OpenAPI 3: components.securitySchemes ; Swagger 2: securityDefinitions
  const schemes =
    spec.components?.securitySchemes || spec.securityDefinitions || {};
  const first = Object.values(schemes)[0];
  if (!first) return { type: "none", headerName: "", tokenUrl: null, requiredVariables: [] };

  const t = (first.type || "").toLowerCase();
  // OpenAPI 3 http+bearer
  if (t === "http") {
    const scheme = (first.scheme || "").toLowerCase();
    if (scheme === "bearer") return { type: "bearer", headerName: "", tokenUrl: null, requiredVariables: ["token"] };
    if (scheme === "basic") return { type: "basic", headerName: "", tokenUrl: null, requiredVariables: ["username", "password"] };
  }
  // OpenAPI 3 apiKey in header  /  Swagger 2 apiKey
  if (t === "apikey") {
    return { type: "apiKey", headerName: first.name || "X-API-Key", tokenUrl: null, requiredVariables: ["api_key"] };
  }
  // Swagger 2 "basic"
  if (t === "basic") return { type: "basic", headerName: "", tokenUrl: null, requiredVariables: ["username", "password"] };
  // oauth2 / openIdConnect → extract tokenUrl, user still needs client_id + client_secret
  if (t === "oauth2" || t === "openidconnect") {
    const tokenUrl = extractTokenUrl(first);
    return { type: "bearer", headerName: "", tokenUrl, requiredVariables: ["client_id", "client_secret"] };
  }
  return { type: "none", headerName: "", tokenUrl: null, requiredVariables: [] };
}

// ---------- public: import ----------

function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/**
 * Parse a spec and upsert it as an ApiProject + its endpoints (Docs keyed by
 * projectId). Decoupled from any GitHub owner/repo so it scales and can be
 * GitHub-linked later. Re-importing the same spec updates the same project.
 */
async function importSpec({ specText, userId, companyId, projectId }) {
  const spec = parseSpec(specText);
  const endpoints = specToEndpoints(spec);

  if (endpoints.length === 0) {
    const err = new Error("Spec parsed but no endpoints were found in `paths`");
    err.statusCode = 400;
    throw err;
  }

  const title = spec.info?.title || "Untitled API";
  const name = slugify(title) || "api";
  const baseUrl = extractBaseUrl(spec);
  let detectedAuth = detectAuth(spec);

  // If securitySchemes didn't give us a tokenUrl (e.g. spec uses http bearer),
  // scan paths for a POST token endpoint and derive it.
  if (!detectedAuth.tokenUrl) {
    const tokenPath = Object.keys(spec.paths || {}).find(
      (p) => /\/(oauth|auth|connect|oidc)?\/?token(\/?)$/.test(p) && spec.paths[p]?.post
    );
    if (tokenPath) {
      const derivedUrl = baseUrl ? `${baseUrl.replace(/\/$/, "")}${tokenPath}` : tokenPath;
      detectedAuth = { ...detectedAuth, tokenUrl: derivedUrl, requiredVariables: ["client_id", "client_secret"] };
    }
  }

  // Collect all path parameters across every endpoint (e.g. {requestId}, {providerId}).
  // These become required variables the user must fill — Olivia tells them up front.
  const pathParamSet = new Set();
  for (const p of Object.keys(spec.paths || {})) {
    for (const m of (p.match(/\{([^}]+)\}/g) || [])) {
      pathParamSet.add(m.slice(1, -1));
    }
  }
  const pathParams = Array.from(pathParamSet);

  // Find the existing project (explicit id, or by name within the company) so
  // re-imports update in place. Seed baseUrl/auth-type only on first create —
  // never clobber a secret the user already saved.
  let project = projectId
    ? await ApiProject.findOne({ _id: projectId, companyId })
    : await ApiProject.findOne({ companyId, name });

  // Build the initial variables array from data the spec already provides.
  // token_url comes from securitySchemes — user never needs to look it up.
  function buildSpecVariables(existing = []) {
    const vars = existing.map((v) => ({ ...v })); // shallow clone
    if (detectedAuth.tokenUrl) {
      const already = vars.find((v) => v.key === "token_url");
      if (!already) {
        vars.push({ key: "token_url", value: detectedAuth.tokenUrl, secret: false });
      }
      // Never overwrite a value the user already set — just backfill if empty.
      else if (!already.value) {
        already.value = detectedAuth.tokenUrl;
      }
    }
    return vars;
  }

  if (!project) {
    project = await ApiProject.create({
      userId,
      companyId,
      name,
      title,
      version: spec.info?.version || "",
      source: "manual",
      baseUrl: baseUrl || "",
      auth: { type: detectedAuth.type, headerName: detectedAuth.headerName },
      variables: buildSpecVariables([]),
    });
  } else {
    project.title = title;
    project.version = spec.info?.version || project.version;
    if (baseUrl && !project.baseUrl) project.baseUrl = baseUrl;
    // Refresh detected type only if the user hasn't configured a real one yet.
    if (project.auth?.type === "none" && detectedAuth.type !== "none") {
      project.auth.type = detectedAuth.type;
      project.auth.headerName = detectedAuth.headerName;
    }
    project.variables = buildSpecVariables(project.variables || []);
    project.updatedAt = new Date();
    await project.save();
  }

  const ops = endpoints.map((ep) => ({
    updateOne: {
      filter: { projectId: project._id, method: ep.method, path: ep.path },
      update: {
        $set: {
          ...ep,
          projectId: project._id,
          userId,
          companyId,
          source: "backfill",
          sourceFile: "openapi-spec",
          updatedAt: new Date(),
        },
      },
      upsert: true,
    },
  }));

  const result = await Doc.bulkWrite(ops);

  return {
    projectId: project._id,
    title,
    version: project.version,
    detectedAuth, // { type, headerName, tokenUrl, requiredVariables }
    totalEndpoints: endpoints.length,
    created: result.upsertedCount || 0,
    updated: result.modifiedCount || 0,
    baseUrl: project.baseUrl || null,
    autoFilledVariables: detectedAuth.tokenUrl ? ["token_url"] : [],
    // Auth credentials + path params the user must fill — Olivia shows these in the dialog
    requiredVariables: [...(detectedAuth.requiredVariables || []), ...pathParams],
    endpoints: endpoints.map((e) => ({
      method: e.method,
      path: e.path,
      section: e.section,
    })),
  };
}

// ---------- public: per-section Postman collection ----------

const PLACEHOLDER_BY_TYPE = {
  String: "string",
  Number: 0,
  Boolean: true,
  Array: [],
  Object: {},
};

// Build an example body from a Doc's requestBody params (no LLM).
function exampleBodyFromParams(params) {
  if (!params || params.length === 0) return null;
  const body = {};
  for (const p of params) {
    // Only set top-level fields here; nested dotted names stay descriptive.
    if (p.name.includes(".") || p.name.includes("[")) continue;
    body[p.name] = PLACEHOLDER_BY_TYPE[p.type] ?? "string";
  }
  return Object.keys(body).length ? body : null;
}

function joinUrl(baseUrl, path) {
  const b = String(baseUrl || "{{baseUrl}}").replace(/\/+$/, "");
  const p = String(path || "").replace(/^\/+/, "");
  return `${b}/${p}`;
}

/**
 * One Postman collection for a whole section, built straight from the docs —
 * ready to drop into Newman. Each request carries a basic status assertion.
 */
function buildSectionCollection({ section, docs, baseUrl }) {
  const items = docs.map((doc) => {
    const url = joinUrl(baseUrl, doc.path);
    const body = exampleBodyFromParams(doc.requestBody);
    return {
      name: `${doc.method} ${doc.path}`,
      event: [
        {
          listen: "test",
          script: {
            type: "text/javascript",
            exec: [
              "pm.test('status is not a server error', function () {",
              "  pm.expect(pm.response.code).to.be.below(500);",
              "});",
            ],
          },
        },
      ],
      request: {
        method: doc.method,
        header: [{ key: "Content-Type", value: "application/json" }],
        url: { raw: url },
        body: body
          ? {
              mode: "raw",
              raw: JSON.stringify(body, null, 2),
              options: { raw: { language: "json" } },
            }
          : undefined,
      },
    };
  });

  return {
    info: {
      name: `${section}`,
      schema:
        "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    },
    item: items,
  };
}

module.exports = {
  parseSpec,
  specToEndpoints,
  extractBaseUrl,
  importSpec,
  detectAuth,
  buildSectionCollection,
  // exported for tests
  schemaToParams,
  sampleFromSchema,
  deref,
};
