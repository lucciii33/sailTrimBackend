/**
 * MCP Load / Stress Tester  ("k6 for MCP servers")
 * -------------------------------------------------
 * Drives concurrent virtual users (VUs) against the tools of an MCP project and
 * measures how the server holds up under load. Supports the classic profiles —
 * load, stress, spike and soak — plus fully custom ramp stages, all through one
 * stage-driven engine (a stage is `{ target: <VUs>, durationSec: <n> }`).
 *
 * Design notes:
 *  - Each VU opens a PERSISTENT MCP connection (mcpLab.openClient) and fires tool
 *    calls in a loop. This measures real tool latency under load instead of the
 *    per-call connect/teardown overhead that mcpLab.invokeTool would add.
 *  - Tool arguments come from the args the user already filled in the MCP docs
 *    (same resolution order the profiler uses) — the AI does not invent inputs.
 *  - Thresholds are chosen by the tester (all optional). We evaluate only the
 *    ones provided and produce a pass/fail verdict.
 */

const McpProject = require("../model/McpProjectModel.js");
const McpTool = require("../model/McpToolModel.js");
const McpDoc = require("../model/McpDocModel.js");
const McpLoadRun = require("../model/McpLoadRunModel.js");
const mcpLab = require("./mcpLabService.js");
const mcpDocs = require("./mcpDocService.js");
const mcpProjects = require("./mcpProjectService.js");

// --- safety caps so a runaway config can't hammer a server forever ---
const MAX_VUS = 200;
const MAX_DURATION_SEC = 600;
const MAX_REQUESTS = 200_000;
const CONTROL_TICK_MS = 250;
const CONNECT_FAIL_ABORT = 25; // abort if this many connects fail with zero successes

// -------------------------------------------------------------
// Metric helpers
// -------------------------------------------------------------

function quantile(sortedAsc, q) {
  if (!sortedAsc.length) return 0;
  const pos = (sortedAsc.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sortedAsc[base + 1] !== undefined) {
    return Math.round(sortedAsc[base] + rest * (sortedAsc[base + 1] - sortedAsc[base]));
  }
  return sortedAsc[base];
}

function summarizeLatency(samples) {
  if (!samples.length) {
    return { min: 0, p50: 0, p90: 0, p95: 0, p99: 0, max: 0, avg: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, n) => a + n, 0);
  return {
    min: sorted[0],
    p50: quantile(sorted, 0.5),
    p90: quantile(sorted, 0.9),
    p95: quantile(sorted, 0.95),
    p99: quantile(sorted, 0.99),
    max: sorted[sorted.length - 1],
    avg: Math.round(sum / sorted.length),
  };
}

function byteSize(value) {
  if (value === undefined || value === null) return 0;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return Buffer.byteLength(text, "utf8");
}

// -------------------------------------------------------------
// Stage presets — every test type is just a stage schedule
// -------------------------------------------------------------

function buildStages({ testType, vus, durationSec, stages }) {
  if (testType === "custom" && Array.isArray(stages) && stages.length) {
    return stages
      .map((s) => ({
        target: clamp(Math.round(Number(s.target) || 0), 0, MAX_VUS),
        durationSec: clamp(Math.round(Number(s.durationSec) || 0), 1, MAX_DURATION_SEC),
      }))
      .filter((s) => s.durationSec > 0);
  }

  const v = clamp(Math.round(Number(vus) || 10), 1, MAX_VUS);
  const d = clamp(Math.round(Number(durationSec) || 30), 3, MAX_DURATION_SEC);
  const p = (frac) => Math.max(1, Math.round(d * frac));

  switch (testType) {
    case "stress":
      // Step the load up past the expected peak to find the breaking point.
      return [
        { target: Math.max(1, Math.round(v * 0.5)), durationSec: p(0.25) },
        { target: v, durationSec: p(0.25) },
        { target: clamp(Math.round(v * 1.5), 1, MAX_VUS), durationSec: p(0.25) },
        { target: clamp(v * 2, 1, MAX_VUS), durationSec: p(0.15) },
        { target: 0, durationSec: p(0.1) },
      ];
    case "spike":
      // Sit at a baseline, then jump to full VUs almost instantly, then recover.
      return [
        { target: Math.max(1, Math.round(v * 0.1)), durationSec: p(0.3) },
        { target: v, durationSec: Math.max(2, p(0.05)) }, // fast ramp = the spike
        { target: v, durationSec: p(0.2) },
        { target: Math.max(1, Math.round(v * 0.1)), durationSec: p(0.25) },
        { target: 0, durationSec: p(0.1) },
      ];
    case "soak":
      // Moderate load held for a long time to surface leaks / slow degradation.
      return [
        { target: v, durationSec: p(0.08) },
        { target: v, durationSec: p(0.87) },
        { target: 0, durationSec: p(0.05) },
      ];
    case "load":
    default:
      // Ramp up, hold steady at the target, ramp down.
      return [
        { target: v, durationSec: p(0.2) },
        { target: v, durationSec: p(0.6) },
        { target: 0, durationSec: p(0.2) },
      ];
  }
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

/** Desired VU count at `elapsedMs`, linearly interpolated across stages. */
function targetVUsAt(stages, elapsedMs) {
  let acc = 0;
  let prevTarget = 0;
  for (const stage of stages) {
    const stageMs = stage.durationSec * 1000;
    if (elapsedMs <= acc + stageMs) {
      const into = elapsedMs - acc;
      const frac = stageMs === 0 ? 1 : into / stageMs;
      return Math.round(prevTarget + (stage.target - prevTarget) * frac);
    }
    acc += stageMs;
    prevTarget = stage.target;
  }
  return 0;
}

// -------------------------------------------------------------
// Args resolution — reuse what the user put in the docs
// -------------------------------------------------------------

function resolveSampleArgs({ tool, doc, override }) {
  // A tester-supplied override always wins — not every tool takes the same info.
  if (override && typeof override === "object") return override;
  if (doc?.sampleArgs && typeof doc.sampleArgs === "object") return doc.sampleArgs;
  if (tool.suggestedArgs && typeof tool.suggestedArgs === "object") return tool.suggestedArgs;
  return mcpDocs.sampleArgsFromSchema(tool.inputSchema || {});
}

/**
 * Normalize the tester's tool selection. Accepts either:
 *   ["search", "fetch"]                                  (equal weight, doc args)
 *   [{ name, weight?, args? }, ...]                       (per-tool traffic mix + args)
 * Returns a Map name -> { weight, args? }.
 */
function normalizeSelection(selection) {
  const map = new Map();
  if (!Array.isArray(selection)) return map;
  for (const item of selection) {
    if (typeof item === "string") {
      map.set(item, { weight: 1 });
    } else if (item && typeof item === "object" && item.name) {
      map.set(item.name, {
        weight: Math.max(1, Math.round(Number(item.weight) || 1)),
        args: item.args && typeof item.args === "object" ? item.args : undefined,
      });
    }
  }
  return map;
}

function extractToolError(res) {
  if (!res) return null;
  if (res.isError) {
    try {
      const txt = Array.isArray(res.content)
        ? res.content.map((c) => c.text || "").join(" ").trim()
        : JSON.stringify(res.content);
      return txt || "Tool returned isError";
    } catch (_) {
      return "Tool returned isError";
    }
  }
  return null;
}

// -------------------------------------------------------------
// The engine
// -------------------------------------------------------------

async function runLoadTest({
  projectId,
  testType = "load",
  vus,
  durationSec,
  stages: customStages,
  tools: selectedToolNames,
  thresholds = {},
  save = true,
  userId,
  companyId,
}) {
  const projectQuery = { _id: projectId };
  if (companyId) projectQuery.companyId = companyId;
  const project = await McpProject.findOne(projectQuery);
  if (!project) throw new Error("MCP project not found");

  const { config } = await mcpProjects.resolveConfig({ projectId, companyId });

  const toolsQuery = { projectId };
  if (companyId) toolsQuery.companyId = companyId;
  const [allTools, docs] = await Promise.all([
    McpTool.find(toolsQuery).sort({ name: 1 }),
    McpDoc.find(toolsQuery),
  ]);
  if (!allTools.length) throw new Error("Project has no tools to load-test");

  const docByName = new Map(docs.map((d) => [d.toolName, d]));

  // Which tools to hammer + per-tool weight/args — default to all, equal weight.
  const selection = normalizeSelection(selectedToolNames);
  const targets = allTools
    .filter((t) => (selection.size ? selection.has(t.name) : true))
    .map((t) => {
      const sel = selection.get(t.name) || { weight: 1 };
      return {
        name: t.name,
        weight: sel.weight || 1,
        args: resolveSampleArgs({
          tool: { ...t.toObject(), suggestedArgs: t.suggestedArgs },
          doc: docByName.get(t.name),
          override: sel.args,
        }),
      };
    });
  if (!targets.length) throw new Error("None of the selected tools exist in this project");

  // Weighted pick order: a tool with weight 3 appears 3x as often in the loop.
  const pickOrder = [];
  targets.forEach((t, idx) => {
    for (let i = 0; i < t.weight; i++) pickOrder.push(idx);
  });

  const stages = buildStages({ testType, vus, durationSec, stages: customStages });
  const totalDurationSec = stages.reduce((a, s) => a + s.durationSec, 0);
  const totalDurationMs = totalDurationSec * 1000;
  const peakTarget = stages.reduce((m, s) => Math.max(m, s.target), 0);

  // ---- shared metric state ----
  const start = Date.now();
  const endTime = start + totalDurationMs;
  const globalLatencies = [];
  const buckets = new Map(); // sec -> { requests, failed, latencies: [], vus }
  const perTool = new Map(); // name -> { requests, ok, failed, latencies, bytesSum, firstError }
  for (const t of targets) {
    perTool.set(t.name, { requests: 0, ok: 0, failed: 0, latencies: [], bytesSum: 0, firstError: null });
  }
  let totalRequests = 0;
  let okRequests = 0;
  let failedRequests = 0;
  let connectFailures = 0;
  let aborted = false;
  let abortReason = null;

  function record(toolName, latency, ok, errMsg, bytes) {
    const now = Date.now();
    const sec = Math.floor((now - start) / 1000);
    let b = buckets.get(sec);
    if (!b) {
      b = { requests: 0, failed: 0, latencies: [], vus: 0 };
      buckets.set(sec, b);
    }
    b.requests += 1;
    b.latencies.push(latency);
    globalLatencies.push(latency);
    totalRequests += 1;
    const pt = perTool.get(toolName);
    pt.requests += 1;
    pt.latencies.push(latency);
    if (ok) {
      okRequests += 1;
      pt.ok += 1;
      pt.bytesSum += bytes;
    } else {
      failedRequests += 1;
      pt.failed += 1;
      b.failed += 1;
      if (!pt.firstError && errMsg) pt.firstError = errMsg;
    }
  }

  // ---- worker (virtual user) ----
  const liveWorkers = new Set();
  let rrIndex = 0; // round-robin cursor across tools

  async function spawnWorker() {
    const state = { stopped: false };
    liveWorkers.add(state);
    const run = (async () => {
      let conn = null;
      try {
        conn = await mcpLab.openClient(config);
      } catch (e) {
        connectFailures += 1;
        record("__connect__", 0, false, `connect failed: ${e.message}`, 0);
        liveWorkers.delete(state);
        return;
      }
      try {
        while (!state.stopped && Date.now() < endTime && !aborted) {
          if (totalRequests >= MAX_REQUESTS) {
            aborted = true;
            abortReason = `Reached max request cap (${MAX_REQUESTS})`;
            break;
          }
          const tool = targets[pickOrder[rrIndex % pickOrder.length]];
          rrIndex += 1;
          const t0 = Date.now();
          let ok = true;
          let errMsg = null;
          let bytes = 0;
          try {
            const res = await conn.callTool(tool.name, tool.args);
            const toolErr = extractToolError(res);
            if (toolErr) {
              ok = false;
              errMsg = toolErr;
            }
            bytes = byteSize(res);
          } catch (e) {
            ok = false;
            errMsg = e.message || String(e);
          }
          record(tool.name, Date.now() - t0, ok, errMsg, bytes);
        }
      } finally {
        await conn.close();
        liveWorkers.delete(state);
      }
    })();
    state.promise = run;
    return state;
  }

  // ---- control loop: ramp VUs to match the stage schedule ----
  await new Promise((resolve) => {
    const timer = setInterval(async () => {
      const elapsed = Date.now() - start;

      // Bail out early on a dead server.
      if (connectFailures >= CONNECT_FAIL_ABORT && okRequests === 0) {
        aborted = true;
        abortReason = `Server unreachable: ${connectFailures} connection failures with no successful calls`;
      }

      if (elapsed >= totalDurationMs || aborted) {
        clearInterval(timer);
        for (const w of liveWorkers) w.stopped = true;
        await Promise.allSettled([...liveWorkers].map((w) => w.promise));
        resolve();
        return;
      }

      const desired = clamp(targetVUsAt(stages, elapsed), 0, MAX_VUS);
      // record VU level into the current bucket
      const sec = Math.floor(elapsed / 1000);
      const b = buckets.get(sec) || { requests: 0, failed: 0, latencies: [], vus: 0 };
      b.vus = Math.max(b.vus, liveWorkers.size);
      buckets.set(sec, b);

      const diff = desired - liveWorkers.size;
      if (diff > 0) {
        for (let i = 0; i < diff; i++) spawnWorker();
      } else if (diff < 0) {
        let toStop = -diff;
        for (const w of liveWorkers) {
          if (toStop-- <= 0) break;
          w.stopped = true;
        }
      }
    }, CONTROL_TICK_MS);
  });

  const actualDurationSec = Math.max(1, (Date.now() - start) / 1000);

  // ---- aggregate ----
  const toolResults = targets.map((t) => {
    const pt = perTool.get(t.name);
    return {
      toolName: t.name,
      weight: t.weight,
      requests: pt.requests,
      ok: pt.ok,
      failed: pt.failed,
      errorRatePct: pt.requests ? +((pt.failed / pt.requests) * 100).toFixed(2) : 0,
      throughputRps: +(pt.requests / actualDurationSec).toFixed(2),
      latencyMs: summarizeLatency(pt.latencies),
      avgResponseBytes: pt.ok ? Math.round(pt.bytesSum / pt.ok) : 0,
      firstError: pt.firstError,
      args: t.args,
    };
  });

  const timeSeries = [...buckets.keys()]
    .sort((a, b) => a - b)
    .map((sec) => {
      const b = buckets.get(sec);
      return {
        t: sec,
        activeVUs: b.vus,
        requests: b.requests,
        failed: b.failed,
        p95Ms: summarizeLatency(b.latencies).p95,
        rps: b.requests, // one bucket == one second
      };
    });

  const summary = {
    totalRequests,
    okRequests,
    failedRequests,
    errorRatePct: totalRequests ? +((failedRequests / totalRequests) * 100).toFixed(2) : 0,
    throughputRps: +(totalRequests / actualDurationSec).toFixed(2),
    latencyMs: summarizeLatency(globalLatencies),
    actualDurationSec: Math.round(actualDurationSec),
    peakVUs: timeSeries.reduce((m, x) => Math.max(m, x.activeVUs), 0),
  };

  const { thresholdResults, verdict } = evaluateThresholds(thresholds, summary);
  const notes = buildNotes({ summary, toolResults, timeSeries, aborted, abortReason });

  const payload = {
    projectId,
    serverName: config?.name || project.projectName,
    serverUrl: mcpProjects.publicServerUrl(config?.url),
    transport: config?.transport || "http",
    testType,
    stages,
    selectedTools: targets.map((t) => t.name),
    peakVUs: peakTarget,
    totalDurationSec,
    thresholds,
    summary,
    thresholdResults,
    verdict,
    notes,
    tools: toolResults,
    timeSeries,
  };

  if (save) {
    const saved = await McpLoadRun.create({ ...payload, userId, companyId });
    payload.runId = saved._id;
  }
  return payload;
}

// -------------------------------------------------------------
// Threshold evaluation (tester-defined, all optional)
// -------------------------------------------------------------

function evaluateThresholds(thresholds = {}, summary) {
  const checks = [];
  const add = (metric, op, target, actual) => {
    if (target === undefined || target === null || target === "" || Number.isNaN(Number(target))) return;
    const tgt = Number(target);
    const passed = op === "<=" ? actual <= tgt : actual >= tgt;
    checks.push({ metric, op, target: tgt, actual: +Number(actual).toFixed(2), passed });
  };

  add("p95Ms", "<=", thresholds.p95Ms, summary.latencyMs.p95);
  add("p99Ms", "<=", thresholds.p99Ms, summary.latencyMs.p99);
  add("errorRatePct", "<=", thresholds.errorRatePct, summary.errorRatePct);
  add("minThroughputRps", ">=", thresholds.minThroughputRps, summary.throughputRps);

  let verdict = "no-thresholds";
  if (checks.length) verdict = checks.every((c) => c.passed) ? "pass" : "fail";
  return { thresholdResults: checks, verdict };
}

// -------------------------------------------------------------
// Heuristic interpretation (deterministic, no LLM/token cost)
// -------------------------------------------------------------

function buildNotes({ summary, toolResults, timeSeries, aborted, abortReason }) {
  const notes = [];
  if (aborted && abortReason) notes.push(`Run aborted early: ${abortReason}`);

  if (summary.errorRatePct >= 5) {
    notes.push(
      `Error rate hit ${summary.errorRatePct}% under load — the server is dropping calls, not just slowing down.`
    );
  }

  // Slowest / most error-prone tool.
  const okTools = toolResults.filter((t) => t.requests > 0);
  const slowest = okTools.reduce((b, t) => (!b || t.latencyMs.p95 > b.latencyMs.p95 ? t : b), null);
  if (slowest && slowest.latencyMs.p95 > 0) {
    notes.push(`Slowest tool: \`${slowest.toolName}\` at p95 ${slowest.latencyMs.p95}ms.`);
  }
  const worstErr = okTools.reduce((b, t) => (!b || t.errorRatePct > b.errorRatePct ? t : b), null);
  if (worstErr && worstErr.errorRatePct >= 5) {
    notes.push(
      `\`${worstErr.toolName}\` failed ${worstErr.errorRatePct}% of calls${worstErr.firstError ? ` (e.g. "${truncate(worstErr.firstError, 120)}")` : ""}.`
    );
  }

  // Breaking point: first second where errors spike or p95 blows past baseline.
  const bp = findBreakingPoint(timeSeries);
  if (bp) {
    notes.push(
      `Breaking point around ~${bp.activeVUs} VUs (t=${bp.t}s): ${bp.reason}.`
    );
  }

  // Degradation over the run (soak-style).
  const degradation = latencyDegradation(timeSeries);
  if (degradation && degradation.pct >= 50) {
    notes.push(
      `p95 latency degraded ${degradation.pct}% from start (${degradation.early}ms) to end (${degradation.late}ms) — possible leak or resource exhaustion.`
    );
  }

  if (!notes.length) {
    notes.push(
      `Held ${summary.throughputRps} req/s across ${summary.totalRequests} calls at p95 ${summary.latencyMs.p95}ms with ${summary.errorRatePct}% errors — no obvious saturation.`
    );
  }
  return notes;
}

function findBreakingPoint(ts) {
  if (ts.length < 3) return null;
  const baseline = summarizeLatency(ts.slice(0, Math.max(1, Math.floor(ts.length * 0.2))).flatMap((b) => Array(b.requests).fill(b.p95Ms))).p95 || ts[0].p95Ms || 1;
  for (const b of ts) {
    const errPct = b.requests ? (b.failed / b.requests) * 100 : 0;
    if (errPct >= 10) return { t: b.t, activeVUs: b.activeVUs, reason: `errors reached ${errPct.toFixed(0)}%` };
    if (baseline && b.p95Ms >= baseline * 3 && b.p95Ms > 500) {
      return { t: b.t, activeVUs: b.activeVUs, reason: `p95 tripled to ${b.p95Ms}ms` };
    }
  }
  return null;
}

function latencyDegradation(ts) {
  if (ts.length < 6) return null;
  const n = Math.max(1, Math.floor(ts.length * 0.25));
  const early = Math.round(avg(ts.slice(0, n).map((b) => b.p95Ms)));
  const late = Math.round(avg(ts.slice(-n).map((b) => b.p95Ms)));
  if (!early) return null;
  return { early, late, pct: Math.round(((late - early) / early) * 100) };
}

function avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function truncate(str, n) {
  return str.length > n ? str.slice(0, n) + "…" : str;
}

module.exports = {
  runLoadTest,
  buildStages,
  targetVUsAt,
  summarizeLatency,
  evaluateThresholds,
};
