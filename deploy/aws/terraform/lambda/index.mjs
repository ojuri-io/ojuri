import { EC2Client, DescribeInstancesCommand, StartInstancesCommand } from "@aws-sdk/client-ec2";

const ec2 = new EC2Client({});
const INSTANCE_ID = process.env.INSTANCE_ID;

async function instanceState() {
  const out = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [INSTANCE_ID] }));
  return out.Reservations?.[0]?.Instances?.[0]?.State?.Name ?? "unknown";
}

// This page is what a cross-origin caller receives when the box is asleep, and
// CloudFront serves it in place of whatever they actually requested. Without
// these the browser reports an opaque network failure and the caller cannot
// tell "asleep" from "misconfigured". The body is a fixed error with no
// credentials and no per-user data, so allowing any origin to read it is safe.
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, x-api-key, authorization, idempotency-key",
  "access-control-max-age": "600",
};

function acceptsHtml(event) {
  const headers = event.headers ?? {};
  const accept = headers.accept ?? headers.Accept ?? "";
  return accept.toLowerCase().includes("text/html");
}

function html(state) {
  const booting = state === "pending" || state === "running";

  // Brand surface, so it follows brand.md: the stone scale only, Source Serif 4
  // for the wordmark with the heavier fullstop, and no accent colour — hierarchy
  // comes from weight and spacing rather than contrast. Fonts are stacks, not
  // webfont links: a downtime page must render before anything can fail to load.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Ojuri — sandbox asleep</title>
<style>
  :root {
    --stone-100: #FAF6F0; --stone-300: #D9D2C6; --stone-400: #B0A89B;
    --stone-500: #857E72; --stone-600: #5C564C; --stone-800: #2A2620;
    --stone-900: #1A1612;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: var(--stone-900); color: var(--stone-100);
    font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    font-size: 16px; line-height: 1.6;
  }
  main { max-width: 34rem; padding: 2.5rem 1.5rem; }
  .mark {
    font-family: "Source Serif 4", "Source Serif Pro", Georgia, serif;
    font-weight: 600; letter-spacing: -0.02em; font-size: 24px; color: var(--stone-100);
  }
  .mark b { font-weight: 700; }
  .label {
    margin-top: 2.75rem; font-family: "JetBrains Mono", "SF Mono", Menlo, monospace;
    font-size: 11px; letter-spacing: 0.05em; text-transform: uppercase; color: var(--stone-500);
  }
  h1 {
    font-family: "Source Serif 4", "Source Serif Pro", Georgia, serif;
    font-weight: 600; letter-spacing: -0.02em; font-size: 30px; line-height: 1.14;
    margin: 0.75rem 0 0; color: var(--stone-100);
  }
  p { color: var(--stone-400); margin: 1.25rem 0 0; max-width: 46ch; }
  button {
    margin-top: 2rem; font: inherit; font-size: 14px; font-weight: 500;
    color: var(--stone-900); background: var(--stone-100);
    border: 0; border-radius: 4px; padding: 0.7rem 1.35rem; cursor: pointer;
    transition: background 160ms ease;
  }
  button:hover:not(:disabled) { background: #fff; }
  button:disabled { opacity: 0.45; cursor: default; }
  .status {
    margin-top: 1.5rem; font-family: "JetBrains Mono", "SF Mono", Menlo, monospace;
    font-size: 12.5px; color: var(--stone-500); font-variant-numeric: tabular-nums;
  }
  .rule { margin-top: 2.75rem; height: 1px; background: var(--stone-800); }
  .foot { margin-top: 1.25rem; font-size: 13px; color: var(--stone-600); }
  .foot a { color: var(--stone-400); text-decoration: none; border-bottom: 1px solid var(--stone-700); }
  .foot a:hover { color: var(--stone-100); }
  .spinner {
    display: inline-block; width: .7em; height: .7em; margin-right: .55em;
    border: 1.5px solid var(--stone-600); border-top-color: var(--stone-300);
    border-radius: 50%; animation: spin .8s linear infinite; vertical-align: -.05em;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
<main>
  <div class="mark">Ojuri<b>.</b></div>
  <div class="label">Sandbox</div>
  <h1>Asleep, and cheap to wake.</h1>
  <p>This environment stops itself when nobody is using it. Waking it takes about three minutes &mdash; Kafka and Postgres come up, migrations run, then the agents start.</p>
  <button id="wake"${booting ? " disabled" : ""}>Wake it up</button>
  <div class="status" id="status">${booting ? '<span class="spinner"></span>starting&hellip;' : ""}</div>
  <div class="rule"></div>
  <p class="foot">Ojuri bears witness to every transaction. <a href="https://ojuri.io">ojuri.io</a> &middot; <a href="https://github.com/ojuri-io/ojuri">source</a></p>
</main>
<script>
  const btn = document.getElementById("wake");
  const status = document.getElementById("status");
  const spinner = '<span class="spinner"></span>';
  let polling = ${booting};

  function poll() {
    fetch("/_wake/status", { cache: "no-store" })
      .then(r => r.json())
      .then(d => {
        if (d.state === "running") {
          status.innerHTML = spinner + "services starting&hellip;";
          fetch("/", { method: "HEAD", cache: "no-store" })
            .then(r => { if (r.ok) location.href = "/"; })
            .catch(() => {});
        } else {
          status.innerHTML = spinner + d.state + "&hellip;";
        }
      })
      .catch(() => {});
  }

  btn.addEventListener("click", () => {
    btn.disabled = true;
    status.innerHTML = spinner + "sending start request&hellip;";
    fetch("/_wake/start", { method: "POST" })
      .then(() => { polling = true; setInterval(poll, 5000); poll(); })
      .catch(() => {
        status.textContent = "could not start it — try again in a moment";
        btn.disabled = false;
      });
  });

  if (polling) { setInterval(poll, 5000); poll(); }
</script>
</body>
</html>`;
}

export const handler = async (event) => {
  const method = event.requestContext?.http?.method ?? "GET";
  const path = event.rawPath ?? "/";

  try {
    if (method === "OPTIONS") {
      return { statusCode: 204, headers: { ...CORS, "cache-control": "no-store" } };
    }

    if (path.endsWith("/status")) {
      return {
        statusCode: 200,
        headers: { ...CORS, "content-type": "application/json", "cache-control": "no-store" },
        body: JSON.stringify({ state: await instanceState() }),
      };
    }

    if (path.endsWith("/start")) {
      if (method !== "POST") {
        return { statusCode: 405, body: "Use POST" };
      }
      // Starting an already-running instance is a no-op in the EC2 API, so a
      // stuck retry loop or a spammed button costs nothing beyond the uptime the
      // instance's own idle and nightly timers already bound.
      await ec2.send(new StartInstancesCommand({ InstanceIds: [INSTANCE_ID] }));
      return {
        statusCode: 202,
        headers: { ...CORS, "content-type": "application/json", "cache-control": "no-store" },
        body: JSON.stringify({ state: "pending" }),
      };
    }

    const state = await instanceState();

    // CloudFront rewrites every origin 5xx to this page, distribution-wide —
    // there is no per-path error config. So an API client calling /v1/predict
    // against a sleeping box would otherwise receive an HTML wake page and fail
    // to parse it. The viewer's Accept header survives to here, which is enough
    // to tell a browser from a caller that wants JSON.
    if (!acceptsHtml(event)) {
      return {
        statusCode: 503,
        headers: { ...CORS, "content-type": "application/json", "cache-control": "no-store" },
        body: JSON.stringify({
          error: "service_unavailable",
          state,
          message:
            state === "running"
              ? "The Ojuri sandbox is starting. Retry in a couple of minutes."
              : "The Ojuri sandbox is asleep. Open the site in a browser to wake it, or POST /_wake/start.",
        }),
      };
    }

    return {
      statusCode: 200,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      body: html(state),
    };
  } catch (err) {
    console.error("wake handler failed", err);
    return {
      statusCode: 500,
      headers: { "content-type": "text/plain", "cache-control": "no-store" },
      body: "The wake service is unavailable.",
    };
  }
};
