import { EC2Client, DescribeInstancesCommand, StartInstancesCommand } from "@aws-sdk/client-ec2";

const ec2 = new EC2Client({});
const INSTANCE_ID = process.env.INSTANCE_ID;

async function instanceState() {
  const out = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [INSTANCE_ID] }));
  return out.Reservations?.[0]?.Instances?.[0]?.State?.Name ?? "unknown";
}

function html(state) {
  const booting = state === "pending" || state === "running";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ojuri test environment</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    background: #0f1115; color: #e6e8ee;
  }
  main { max-width: 34rem; padding: 2rem; text-align: center; }
  h1 { font-size: 1.5rem; margin: 0 0 .5rem; letter-spacing: -0.01em; }
  p { color: #9aa3b2; margin: 0 0 1.5rem; }
  button {
    font: inherit; font-weight: 600; color: #0f1115; background: #7dd3a8;
    border: 0; border-radius: .5rem; padding: .7rem 1.4rem; cursor: pointer;
  }
  button:disabled { opacity: .55; cursor: default; }
  .status { margin-top: 1.5rem; font-variant-numeric: tabular-nums; color: #9aa3b2; }
  .spinner {
    display: inline-block; width: .8em; height: .8em; margin-right: .5em;
    border: 2px solid #4b5563; border-top-color: #7dd3a8; border-radius: 50%;
    animation: spin .8s linear infinite; vertical-align: -.1em;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
<main>
  <h1>This demo is asleep</h1>
  <p>The Ojuri test environment stops itself when idle to keep costs down. Waking it takes about three minutes &mdash; the stack has to bring up Kafka, Postgres, run migrations, then start the services.</p>
  <button id="wake"${booting ? " disabled" : ""}>Wake it up</button>
  <div class="status" id="status">${booting ? '<span class="spinner"></span>Starting&hellip;' : ""}</div>
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
          status.innerHTML = spinner + "Services starting, checking&hellip;";
          fetch("/", { method: "HEAD", cache: "no-store" })
            .then(r => { if (r.ok) location.href = "/"; })
            .catch(() => {});
        } else {
          status.innerHTML = spinner + "Instance " + d.state + "&hellip;";
        }
      })
      .catch(() => {});
  }

  btn.addEventListener("click", () => {
    btn.disabled = true;
    status.innerHTML = spinner + "Sending start request&hellip;";
    fetch("/_wake/start", { method: "POST" })
      .then(() => { polling = true; setInterval(poll, 5000); poll(); })
      .catch(() => {
        status.textContent = "Could not start it. Try again in a moment.";
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
    if (path.endsWith("/status")) {
      return {
        statusCode: 200,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
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
        headers: { "content-type": "application/json", "cache-control": "no-store" },
        body: JSON.stringify({ state: "pending" }),
      };
    }

    return {
      statusCode: 200,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      body: html(await instanceState()),
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
