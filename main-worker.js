/**
 * ============================================================
 *  MAIN WORKER — The Orchestrator
 *  File: main-worker.js
 *
 *  Role: Public-facing API endpoint for LLM tool integration.
 *        Handles routing, load balancing, and security injection.
 *        Does NOT make direct third-party search requests.
 *
 *  Registry Loading — Priority order:
 *    1. registry.json  → bundled at deploy time (static JSON import).
 *                        Edit the file, redeploy, changes take effect.
 *    2. KV namespace   → runtime fallback when registry.json is empty
 *                        or all entries are disabled. Lets you update
 *                        surrogate URLs without a redeployment.
 *
 *  Data Flow:
 *    LLM / Client
 *      → GET ?q=... or POST { "query": "..." }
 *      → CORS preflight check
 *      → Load + filter registry.json (enabled surrogates only)
 *      → Fallback to KV if registry is empty
 *      → Random surrogate selection
 *      → Forward request + inject X-Orchestrator-Secret header
 *      → Surrogate Worker executes search & returns results
 *      → Return uniform JSON envelope to caller
 *
 *  Project layout expected by wrangler:
 *    orchestrator/
 *    ├── main-worker.js   ← this file
 *    ├── registry.json    ← surrogate URL list (same directory)
 *    └── wrangler.toml
 * ============================================================
 */

// ---------------------------------------------------------------------------
// REGISTRY IMPORT
// Wrangler v3 bundles JSON files as ES module imports at deploy time.
// This means registry.json is compiled INTO the worker — no runtime I/O,
// no latency, no extra KV reads for the happy path.
//
// HOW TO UPDATE SURROGATES:
//   1. Edit registry.json (add/remove/toggle "enabled": false entries)
//   2. Run:  wrangler deploy
//   Changes are live within seconds.
// ---------------------------------------------------------------------------
import registryFile from "./registry.json";

// Pull only surrogates that are explicitly enabled.
// Setting "enabled": false lets you disable a broken surrogate without
// removing it from the file.
const REGISTRY_FROM_FILE = (registryFile.surrogates ?? [])
  .filter((s) => s.enabled === true && typeof s.url === "string" && s.url.trim() !== "");

// ---------------------------------------------------------------------------
// CORS HEADERS
// ---------------------------------------------------------------------------
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

// ---------------------------------------------------------------------------
// UNAUTHORIZED HTML — shown to browsers that probe the endpoint directly
// ---------------------------------------------------------------------------
const UNAUTHORIZED_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>403 — Unauthorized</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    @import url('https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Inter:wght@300;400&display=swap');
    :root {
      --bg: #0a0a0f; --surface: #111118; --border: #1e1e2e;
      --accent: #ff3c5f; --accent-dim: rgba(255,60,95,0.12);
      --text: #e0e0f0; --muted: #555570;
    }
    html, body { height: 100%; background: var(--bg); color: var(--text); font-family: 'Inter', sans-serif; }
    body {
      display: flex; align-items: center; justify-content: center; min-height: 100vh;
      background-image:
        radial-gradient(ellipse 80% 50% at 50% -10%, rgba(255,60,95,0.08) 0%, transparent 70%),
        repeating-linear-gradient(0deg, transparent, transparent 39px, var(--border) 40px),
        repeating-linear-gradient(90deg, transparent, transparent 39px, var(--border) 40px);
    }
    .card {
      background: var(--surface); border: 1px solid var(--border); border-top: 3px solid var(--accent);
      padding: 3rem 3.5rem; max-width: 520px; width: 90%;
      box-shadow: 0 0 60px rgba(255,60,95,0.06), 0 20px 60px rgba(0,0,0,0.4);
    }
    .badge {
      display: inline-flex; align-items: center; gap: 0.5rem; font-family: 'Space Mono', monospace;
      font-size: 0.65rem; letter-spacing: 0.12em; text-transform: uppercase; color: var(--accent);
      background: var(--accent-dim); border: 1px solid rgba(255,60,95,0.25);
      padding: 0.3rem 0.75rem; margin-bottom: 1.5rem;
    }
    .badge::before { content:''; width:6px; height:6px; background:var(--accent); border-radius:50%; animation:pulse 1.8s ease-in-out infinite; }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
    h1 { font-family:'Space Mono',monospace; font-size:3rem; font-weight:700; color:var(--accent); line-height:1; margin-bottom:0.5rem; }
    h2 { font-size:1rem; font-weight:300; color:var(--muted); letter-spacing:0.04em; margin-bottom:2rem; }
    p  { font-size:0.875rem; line-height:1.75; color:#8888a8; }
    .code-block {
      margin-top:2rem; background:var(--bg); border:1px solid var(--border);
      padding:1rem 1.25rem; font-family:'Space Mono',monospace; font-size:0.72rem; color:#6666a0; line-height:1.6;
    }
    .code-block span { color:var(--accent); }
    .footer { margin-top:2rem; font-size:0.7rem; color:var(--muted); font-family:'Space Mono',monospace; }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">Security Gateway</div>
    <h1>403</h1>
    <h2>Unauthorized Access</h2>
    <p>This endpoint is an internal API proxy reserved for authorized LLM tool integrations. Direct browser access is not permitted.</p>
    <div class="code-block">
      <span>GET</span>  /?q=your+search+query<br>
      <span>POST</span> /&nbsp;&nbsp;{ "query": "your search query" }
    </div>
    <div class="footer">// orchestrator &nbsp;·&nbsp; cloudflare workers &nbsp;·&nbsp; v1.0.0</div>
  </div>
</body>
</html>`;

// ---------------------------------------------------------------------------
// HELPER — Random surrogate selection
// ---------------------------------------------------------------------------
function pickSurrogate(registry) {
  if (!registry || registry.length === 0) return null;
  return registry[Math.floor(Math.random() * registry.length)];
}

// ---------------------------------------------------------------------------
// HELPER — Uniform JSON response builder
// ---------------------------------------------------------------------------
function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS, ...extraHeaders },
  });
}

// ---------------------------------------------------------------------------
// MAIN HANDLER
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    const url    = new URL(request.url);
    const method = request.method.toUpperCase();

    // ── 1. CORS Preflight ──────────────────────────────────────────────────
    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // ── 2. Method guard — non-API methods get the HTML page ────────────────
    if (method !== "GET" && method !== "POST") {
      return new Response(UNAUTHORIZED_HTML, {
        status: 403,
        headers: { "Content-Type": "text/html;charset=UTF-8", ...CORS_HEADERS },
      });
    }

    // ── 3. Extract query ───────────────────────────────────────────────────
    let query = null;

    if (method === "GET") {
      query = url.searchParams.get("q") ?? url.searchParams.get("query");
    } else {
      try {
        const body = await request.json();
        query = body.query ?? body.q ?? null;
      } catch {
        return jsonResponse({ success: false, error: "Invalid JSON body." }, 400);
      }
    }

    // No query → serve the HTML page (browser navigation with no params)
    if (!query || query.trim() === "") {
      return new Response(UNAUTHORIZED_HTML, {
        status: 403,
        headers: { "Content-Type": "text/html;charset=UTF-8", ...CORS_HEADERS },
      });
    }

    query = query.trim();

    // ── 4. Build active surrogate list ─────────────────────────────────────
    //
    // PRIORITY 1 — registry.json (bundled at deploy time, zero latency)
    //   REGISTRY_FROM_FILE is pre-filtered for enabled:true at module load.
    //
    // PRIORITY 2 — KV namespace (runtime override, no redeploy required)
    //   Push an update with:
    //     wrangler kv:key put --namespace-id=<ID> surrogates \
    //       '[{"id":"s4","url":"https://surrogate-4...workers.dev","enabled":true}]'
    //
    let activeSurrogates = [...REGISTRY_FROM_FILE];

    if (activeSurrogates.length === 0 && env.REGISTRY_KV) {
      try {
        const raw = await env.REGISTRY_KV.get("surrogates");
        if (raw) {
          const parsed = JSON.parse(raw);
          activeSurrogates = (Array.isArray(parsed) ? parsed : parsed.surrogates ?? [])
            .filter((s) => s.enabled !== false && s.url);
        }
      } catch (kvErr) {
        console.error("[orchestrator] KV registry read failed:", kvErr.message);
      }
    }

    if (activeSurrogates.length === 0) {
      return jsonResponse(
        {
          success: false,
          error:   "No surrogate workers available.",
          hint:    "Add enabled surrogates to registry.json and redeploy, or push to the REGISTRY_KV namespace.",
        },
        503
      );
    }

    // ── 5. Pick a surrogate ────────────────────────────────────────────────
    const chosen = pickSurrogate(activeSurrogates);
    // chosen = { id, url, region, enabled }

    // ── 6. Forward to surrogate ────────────────────────────────────────────
    // Inject X-Orchestrator-Secret so the surrogate can authenticate the call.
    // Set this via:  wrangler secret put INTERNAL_SECRET
    const targetUrl = `${chosen.url}?q=${encodeURIComponent(query)}`;

    let surrogateRes;
    try {
      surrogateRes = await fetch(targetUrl, {
        method: "GET",
        headers: {
          "X-Orchestrator-Secret": env.INTERNAL_SECRET ?? "",
          "Content-Type": "application/json",
        },
      });
    } catch (fetchErr) {
      return jsonResponse(
        {
          success:   false,
          error:     "Surrogate unreachable.",
          detail:    fetchErr.message,
          surrogate: chosen,
        },
        502
      );
    }

    // ── 7. Parse surrogate payload ─────────────────────────────────────────
    let surrogateData;
    try {
      surrogateData = await surrogateRes.json();
    } catch {
      return jsonResponse(
        { success: false, error: "Surrogate returned malformed JSON.", surrogate: chosen },
        502
      );
    }

    // ── 8. Return uniform envelope to LLM ─────────────────────────────────
    return jsonResponse({
      success:     surrogateRes.ok,
      query,
      handled_by:  { id: chosen.id, url: chosen.url },
      http_status: surrogateRes.status,
      results:     surrogateData.results ?? [],
      meta:        surrogateData.meta    ?? {},
      error:       surrogateData.error   ?? null,
    });
  },
};
