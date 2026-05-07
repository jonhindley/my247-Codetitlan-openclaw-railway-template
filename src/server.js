import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import express from "express";
import httpProxy from "http-proxy";
import pty from "node-pty";
import { WebSocketServer } from "ws";

const PORT = Number.parseInt(process.env.PORT ?? "8080", 10);
const STATE_DIR =
  process.env.OPENCLAW_STATE_DIR?.trim() ||
  path.join(os.homedir(), ".openclaw");
const WORKSPACE_DIR =
  process.env.OPENCLAW_WORKSPACE_DIR?.trim() ||
  path.join(STATE_DIR, "workspace");

const SETUP_PASSWORD = process.env.SETUP_PASSWORD?.trim();

const MY247_AUTO_APPROVE_FIRST_DEVICE =
  process.env.MY247_AUTO_APPROVE_FIRST_DEVICE?.toLowerCase() === "true";

const MY247_AUTO_APPROVE_WINDOW_MS = Number.parseInt(
  process.env.MY247_AUTO_APPROVE_WINDOW_MS ?? "0",
  10
);

const MY247_AUTO_APPROVE_INTERVAL_MS = Number.parseInt(
  process.env.MY247_AUTO_APPROVE_INTERVAL_MS ?? "3000",
  10
);

const MY247_AUTO_APPROVE_MAX_APPROVALS = Number.parseInt(
  process.env.MY247_AUTO_APPROVE_MAX_APPROVALS ?? "5",
  10
);

const LOG_FILE = path.join(STATE_DIR, "server.log");
const LOG_RING_BUFFER_MAX = 1000;
const MAX_LOG_FILE_SIZE = 5 * 1024 * 1024;
const logRingBuffer = [];
const sseClients = new Set();

function writeLog(level, category, message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${level}] [${category}] ${message}`;

  const consoleFn =
    level === "ERROR"
      ? console.error
      : level === "WARN"
        ? console.warn
        : console.log;
  consoleFn(line);

  logRingBuffer.push(line);
  if (logRingBuffer.length > LOG_RING_BUFFER_MAX) {
    logRingBuffer.shift();
  }

  for (const client of sseClients) {
    try {
      client.write(`data: ${JSON.stringify(line)}\n\n`);
    } catch {
      sseClients.delete(client);
    }
  }

  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line + "\n");
    const stat = fs.statSync(LOG_FILE);
    if (stat.size > MAX_LOG_FILE_SIZE) {
      const content = fs.readFileSync(LOG_FILE, "utf8");
      const lines = content.split("\n");
      fs.writeFileSync(LOG_FILE, lines.slice(Math.floor(lines.length / 2)).join("\n"));
    }
  } catch {}
}

const log = {
  info: (category, message) => writeLog("INFO", category, message),
  warn: (category, message) => writeLog("WARN", category, message),
  error: (category, message) => writeLog("ERROR", category, message),
};

function my247Env(name) {
  return process.env[name]?.trim() || "";
}

function seedMy247WorkspaceFiles(reason = "startup") {
  try {
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

    const assistantName = my247Env("MY247_ASSISTANT_NAME");
    const customerName = my247Env("MY247_CUSTOMER_NAME");
    const customerEmail = my247Env("MY247_CUSTOMER_EMAIL");
    const owner = customerName || "the customer";

    fs.writeFileSync(path.join(WORKSPACE_DIR, "AGENTS.md"), `# my24-7assistant operating instructions

## Session Startup

Before answering questions about your name, identity, the user, preferences, standing instructions, or prior setup, check these files directly:

- /data/workspace/SOUL.md
- /data/workspace/IDENTITY.md
- /data/workspace/USER.md
- /data/workspace/MEMORY.md
- /data/workspace/TOOLS.md

Use SOUL.md and IDENTITY.md for your assistant name, persona, and tone.
Use USER.md for the owner's profile.
Use MEMORY.md as durable fallback memory.
Use TASKS.md as a durable audit trail for requested reminders, recurring tasks, and scheduled tasks. When an OpenClaw cron/scheduler tool is available, create a real scheduled job as well as recording the request in TASKS.md.

## First-run onboarding

When starting with a new customer, introduce yourself briefly and help them personalise you. A good first message is:

"Hello, I’m your new my24-7assistant. To get started, you can tell me what name you’d like to call me, what I should call you, and how you like me to communicate — for example concise, chatty, professional, practical, or friendly. When you’re ready to connect me to WhatsApp so we can chat anytime, say 'connect WhatsApp' and I’ll guide you."

If the user gives you a name, their preferred name, or communication preferences, store them durably in the appropriate workspace files.

## WhatsApp setup

If the user says "connect WhatsApp", "set up WhatsApp", or asks how to chat through WhatsApp, direct them to the my24-7assistant WhatsApp setup page on this assistant:

- /my247/whatsapp

Tell them to use that setup page, click Start WhatsApp linking, then scan the QR using WhatsApp → Linked Devices → Link a Device.

Do not direct normal users to the raw OpenClaw Channels page for WhatsApp setup during beta.

## Durable self-configuration

When the user gives you durable information, update the appropriate workspace file without requiring Terminal access:

- Assistant name, personality, tone, or identity: update /data/workspace/SOUL.md and /data/workspace/IDENTITY.md
- Owner name, profile, preferences, location, or contact details: update /data/workspace/USER.md
- Long-term facts, preferences, decisions, and useful context: update /data/workspace/MEMORY.md
- Standing instructions about how to work, answer, browse, or behave: update /data/workspace/AGENTS.md carefully, preserving existing rules
- Recurring task requests such as daily weather, reminders, or summaries: create a real OpenClaw cron/scheduled job when possible, and also record the request and job details in /data/workspace/TASKS.md

After updating a durable file, confirm what you changed and where you stored it.

If memory_search fails because of an embeddings, API-key, provider, or 401 error, first check the workspace files directly.

Do not ask the user to repeat durable information until you have checked the relevant workspace files.

## Recurring tasks

If the user asks for a scheduled or recurring task, create a real OpenClaw cron/scheduled job when the cron/scheduler tool is available, then record the task, schedule, and job id in TASKS.md.

Do not claim a reminder or scheduled task will run unless a real cron/scheduled job was successfully created. If scheduling is not available or job creation fails, say clearly that you have recorded the request but automatic execution still needs to be enabled.

## Current information fallback

For current information requests such as weather, news, prices, schedules, live facts, or recent events:
- Prefer browser/web access when available.
- If a dedicated API/search/news/weather tool is unavailable or missing a key, do not ask the user for an API key.
- Fall back to browser/web access or direct page navigation.
- Do not expose internal missing API-key/tool errors to normal users.
- If browser/web access also fails, say clearly what you tried and suggest one practical fallback.

For beta tester guidance, remember that my24-7assistant is used through the website/dashboard and assistant chat. Do not invent an app installation step.

## Browser and web page access

When browsing, use openclaw browser open <url> and openclaw browser snapshot. Do not use browser-control.

## Capability-first behaviour

Do not give up too early.

Before saying "I can't do that", "not available", or "you need to set this up yourself":

1. Check the relevant workspace files.
2. Check available OpenClaw tools or CLI commands.
3. Try the most appropriate tool.
4. If that fails, try one reasonable fallback.
5. Only then explain the limitation clearly and briefly.

Do not give normal customers raw internal errors, missing API-key diagnostics, Linux package instructions, Google Cloud project instructions, or developer setup steps unless they explicitly ask for technical diagnostics.

The customer experience should be:
- helpful,
- practical,
- calm,
- action-oriented,
- and never unnecessarily negative.

If a feature is not yet connected, say what is currently possible and what the next customer-friendly step is.

## Shared session context

Use /data/workspace/SESSION_CONTEXT.md as the quickest shared context file.

Before answering questions about the user's name, assistant name, identity, preferences, previous setup, standing instructions, WhatsApp, recurring tasks, or available tools, check /data/workspace/SESSION_CONTEXT.md first if it exists.

If SESSION_CONTEXT.md is missing or incomplete, check:
- /data/workspace/USER.md
- /data/workspace/SOUL.md
- /data/workspace/IDENTITY.md
- /data/workspace/MEMORY.md
- /data/workspace/TASKS.md
- /data/workspace/TOOLS.md

The user/customer name belongs in USER.md and MEMORY.md.
The assistant name/persona belongs in SOUL.md and IDENTITY.md.
Do not confuse the customer name with the assistant name.

## OpenClaw cron and scheduled jobs

OpenClaw cron is the correct scheduler. Do not suggest installing Linux cron, using sudo, apt, yum, or systemctl inside the Railway container.

For scheduled or recurring tasks, use the OpenClaw Gateway scheduler:

- Check status with: openclaw cron status
- List jobs with: openclaw cron list
- Add jobs with: openclaw cron add

For one-shot reminders, prefer:
openclaw cron add --name "Reminder: short description" --at 10m --message "Reminder: reminder text" --announce --expect-final --delete-after-run --json

For recurring jobs, prefer:
openclaw cron add --cron "0 7 * * *" --tz "Africa/Johannesburg" --message "task text" --announce --expect-final

When creating a job:
1. Create the real cron job first.
2. Confirm it appears in openclaw cron list.
3. Record the task, schedule, and job id in /data/workspace/TASKS.md.
4. Tell the user it is scheduled only after the cron job was created successfully.



Working reminder command pattern:

For web/control-ui reminders:
openclaw cron add --name "Reminder: short description" --at 3m --message "Reminder: [reminder text]" --announce --expect-final --delete-after-run --json

For WhatsApp reminders when the number is known:
openclaw cron add --name "Reminder: short description" --at 3m --message "Reminder: [reminder text]" --announce --to "+27662989575" --channel whatsapp --expect-final --delete-after-run --json

Important:
- --name is required.
- Use --at 3m, not --at +3m.
- Use --message, not --system-event, for user-facing reminders.
- Use --announce for delivery.
- Use --to and --channel whatsapp for WhatsApp delivery.
- deliveryStatus: delivered means the reminder was sent.
- deliveryStatus: not-requested means delivery was not configured correctly.

If cron creation fails:
1. Read the error.
2. Try one safe correction.
3. If still failing, explain the specific issue and ask for help.
4. Do not merely say "job failed".

## Web search and browsing

For current facts, live information, websites, events, prices, schedules, or recent information, try tools before saying search is unavailable.

Use this order:
1. If the user gave a URL, use openclaw browser open <url>, then openclaw browser snapshot.
2. If no URL is given but the task is current/live, try the configured search tool if available.
3. If search is not configured, use direct browser navigation to likely official sites where practical.
4. If browser access fails, try simple page retrieval with chromium --dump-dom <url> when a URL is known.
5. If all methods fail, explain what was tried and ask for a URL or pasted text.

After opening a page, extract the answer to the user's exact question. Do not just summarise the page or tell the user to check the website.

Look specifically for:
- dates,
- entry status,
- registration links,
- opening and closing dates,
- official notices,
- prices,
- eligibility,
- contact details,
- next action.

Do not expose missing Brave/Search API key errors to normal customers. Say: "I can open specific webpages if you give me a URL, but broad web search is not currently configured."



## my247 WhatsApp reminder helper

For WhatsApp reminders, you MUST use the my24-7 helper command instead of manually constructing cron jobs or using the internal cron/system-event tool.

Use this command:

my247-remind-whatsapp --to "+27662989575" --in 3m --text "reminder text"

This helper creates a real OpenClaw cron job using the proven WhatsApp delivery syntax:
- --name
- --at 3m, not +3m
- --message
- --announce
- --to
- --channel whatsapp
- --expect-final
- --delete-after-run
- --json

The helper also writes the job details to /data/workspace/TASKS.md.

Do not use --system-event for user-facing reminders. Do not create internal systemEvent reminders for WhatsApp delivery.
Do not claim the reminder is scheduled unless the helper returns successful JSON with a job id. If you did not run my247-remind-whatsapp, the WhatsApp reminder is not scheduled.



## Web search quality rules

When using web_search:
- Prefer official sources first: the event organiser, brand owner, official website, government site, company site, school site, or primary source.
- Disambiguate similarly named events, companies, places, and products before answering.
- If the user asks about a specific event and there are multiple events with the same or similar name, do not answer from the first search result. Identify the intended event by country, domain, organiser, or prior conversation context.
- If a search result conflicts with a direct official website already opened in the conversation, trust the official website unless there is strong evidence it is outdated.
- For South African Double Century cycling queries, prefer the official site https://doublecentury.co.za/ and sources referring to Old Mutual Wealth Double Century / Swellendam / South Africa. Do not confuse it with Davis Double Century.
- Always name the source used. If the source is not official, say so.
- Do not invent headings, dates, prices, or facts if the fetched content is unclear. Say what was and was not visible.

## Google Workspace / Calendar / Gmail

Normal customers should not be told to create a Google Cloud project.

## my247 Google Calendar helper

Google Calendar may be connected through the my24-7assistant platform OAuth flow.

Use the helper command examples:

my247-calendar status --email "customer@example.com"
my247-calendar connect-link --email "customer@example.com" --mode calendar_events
my247-calendar list --email "customer@example.com" --from "2026-05-08T00:00:00+02:00" --to "2026-05-09T00:00:00+02:00"
my247-calendar create --email "customer@example.com" --title "Dentist" --start "2026-05-08T09:00:00+02:00" --end "2026-05-08T09:30:00+02:00" --confirmed
my247-calendar update --email "customer@example.com" --event-id "EVENT_ID" --start "2026-05-08T10:00:00+02:00" --end "2026-05-08T10:30:00+02:00" --confirmed
my247-calendar delete --email "customer@example.com" --event-id "EVENT_ID" --confirmed

Calendar read requests:
- Use my247-calendar status or my247-calendar list.
- If Calendar is not connected, provide the secure connect link from my247-calendar connect-link.
- Do not tell the user to create a Google Cloud project.

Calendar write requests:
- A clear user instruction counts as confirmation.
- Do not ask for a second confirmation for straightforward requests, such as adding a clearly specified event or moving a clearly identified event.
- Use --confirmed when the user has clearly requested the action.
- Ask for clarification or confirmation only when the request is ambiguous, destructive, affects multiple events, has missing/uncertain date/time/title details, or could match multiple events.
- If access is read-only, explain that write access requires reconnecting with calendar_events permission.

Gmail is not connected yet. For Gmail requests, say:
"Google Gmail connection is not enabled for this assistant yet. Calendar can be connected by clicking an authorisation link and approving access with Google. You should not need to create a Google Cloud project yourself."

Do not attempt invalid local commands for Google Calendar or Gmail setup.
Do not invent access to the user's Google account.

If tools are available, use them. If tools are not available, explain clearly and offer the next practical customer-friendly step.

`, "utf8");

    if (assistantName) {
      fs.writeFileSync(path.join(WORKSPACE_DIR, "SOUL.md"), `# SOUL.md - Assistant Persona

Your name is ${assistantName}.

You are ${owner}'s my24-7assistant: practical, concise, helpful, and reliable.

When asked your name, answer that your name is ${assistantName}.
`, "utf8");

      fs.writeFileSync(path.join(WORKSPACE_DIR, "IDENTITY.md"), `# IDENTITY.md - Who Am I?

- **Name:** ${assistantName}
- **Creature:** AI assistant
- **Vibe:** practical, concise, helpful, calm, and reliable
- **Emoji:** 🦋
- **Avatar:**

You are ${assistantName}, ${owner}'s my24-7assistant.

When asked your name, answer: My name is ${assistantName}.
`, "utf8");
    }

    if (customerName || customerEmail) {
      fs.writeFileSync(path.join(WORKSPACE_DIR, "USER.md"), `# USER.md - User Profile

- Name: ${customerName}
- Preferred address: ${customerName ? customerName.split(" ")[0] : ""}
- Email: ${customerEmail}
- Notes:
`, "utf8");
    }


    function readWorkspaceFile(name) {
      try {
        const filePath = path.join(WORKSPACE_DIR, name);
        return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8").trim() : "";
      } catch {
        return "";
      }
    }

    const tasksPath = path.join(WORKSPACE_DIR, "TASKS.md");
    if (!fs.existsSync(tasksPath)) {
      fs.writeFileSync(tasksPath, `# TASKS.md - Recurring and Scheduled Task Requests

This file records recurring or scheduled tasks requested by the user.

Important:
- A task listed here is a durable request.
- Do not claim it will run automatically unless a real scheduler, cron, heartbeat, or my24-7assistant task runner is available and confirmed.

## Requested tasks

`, "utf8");
    }


    const sessionContextPath = path.join(WORKSPACE_DIR, "SESSION_CONTEXT.md");
    const sessionContext = `# SESSION_CONTEXT.md - Shared Session Context

This file gives every web and WhatsApp session a compact durable context summary.

## Assistant identity

${readWorkspaceFile("SOUL.md")}

## Assistant identity details

${readWorkspaceFile("IDENTITY.md")}

## User/customer profile

${readWorkspaceFile("USER.md")}

## Durable memory

${readWorkspaceFile("MEMORY.md")}

## Scheduled tasks

${readWorkspaceFile("TASKS.md")}

## Tool notes

${readWorkspaceFile("TOOLS.md")}
`;
    fs.writeFileSync(sessionContextPath, sessionContext, "utf8");

    log.info("my247-workspace", `workspace bootstrap complete (${reason})`);
  } catch (err) {
    log.warn("my247-workspace", `workspace bootstrap failed (${reason}): ${err.message}`);
  }
}

function resolveGatewayToken() {
  const envTok = process.env.OPENCLAW_GATEWAY_TOKEN?.trim();
  if (envTok) return envTok;

  const tokenPath = path.join(STATE_DIR, "gateway.token");
  try {
    const existing = fs.readFileSync(tokenPath, "utf8").trim();
    if (existing) return existing;
  } catch (err) {
    log.warn("gateway-token", `could not read existing token: ${err.code || err.message}`);
  }

  const generated = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(tokenPath, generated, { encoding: "utf8", mode: 0o600 });
  } catch (err) {
    log.warn("gateway-token", `could not persist token: ${err.code || err.message}`);
  }
  return generated;
}

const OPENCLAW_GATEWAY_TOKEN = resolveGatewayToken();
process.env.OPENCLAW_GATEWAY_TOKEN = OPENCLAW_GATEWAY_TOKEN;

let cachedOpenclawVersion = null;
let cachedChannelsHelp = null;

async function getOpenclawInfo() {
  if (!cachedOpenclawVersion) {
    const [version, channelsHelp] = await Promise.all([
      runCmd(OPENCLAW_NODE, clawArgs(["--version"])),
      runCmd(OPENCLAW_NODE, clawArgs(["channels", "add", "--help"])),
    ]);
    cachedOpenclawVersion = version.output.trim();
    cachedChannelsHelp = channelsHelp.output;
  }
  return { version: cachedOpenclawVersion, channelsHelp: cachedChannelsHelp };
}

const INTERNAL_GATEWAY_PORT = Number.parseInt(
  process.env.INTERNAL_GATEWAY_PORT ?? "18789",
  10,
);
const INTERNAL_GATEWAY_HOST = process.env.INTERNAL_GATEWAY_HOST ?? "127.0.0.1";
const GATEWAY_TARGET = `http://${INTERNAL_GATEWAY_HOST}:${INTERNAL_GATEWAY_PORT}`;

const OPENCLAW_ENTRY =
  process.env.OPENCLAW_ENTRY?.trim() || "/openclaw/dist/entry.js";
const OPENCLAW_NODE = process.env.OPENCLAW_NODE?.trim() || "node";

const ENABLE_WEB_TUI = process.env.ENABLE_WEB_TUI?.toLowerCase() === "true";
const TUI_IDLE_TIMEOUT_MS = Number.parseInt(
  process.env.TUI_IDLE_TIMEOUT_MS ?? "300000",
  10,
);

const TUI_MAX_SESSION_MS = Number.parseInt(
  process.env.TUI_MAX_SESSION_MS ?? "1800000",
  10,
);

function clawArgs(args) {
  return [OPENCLAW_ENTRY, ...args];
}

function configPath() {
  return (
    process.env.OPENCLAW_CONFIG_PATH?.trim() ||
    path.join(STATE_DIR, "openclaw.json")
  );
}

function isConfigured() {
  try {
    return fs.existsSync(configPath());
  } catch {
    return false;
  }
}

async function syncAllowedOrigins() {
  const publicDomain = process.env.RAILWAY_PUBLIC_DOMAIN;
  if (!publicDomain) return;

  const origin = `https://${publicDomain}`;
  const result = await runCmd(
    OPENCLAW_NODE,
    clawArgs([
      "config",
      "set",
      "--json",
      "gateway.controlUi.allowedOrigins",
      JSON.stringify([origin]),
    ]),
  );
  if (result.code === 0) {
    log.info("gateway", `set allowedOrigins to [${origin}]`);
  } else {
    log.warn("gateway", `failed to set allowedOrigins (exit=${result.code})`);
  }
}

let gatewayProc = null;
let gatewayStarting = null;
let shuttingDown = false;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForGatewayReady(opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const start = Date.now();
  const endpoints = ["/openclaw", "/openclaw", "/", "/health"];

  while (Date.now() - start < timeoutMs) {
    for (const endpoint of endpoints) {
      try {
        const res = await fetch(`${GATEWAY_TARGET}${endpoint}`, {
          method: "GET",
        });
        if (res) {
          log.info("gateway", `ready at ${endpoint}`);
          return true;
        }
      } catch (err) {
        if (err.code !== "ECONNREFUSED" && err.cause?.code !== "ECONNREFUSED") {
          const msg = err.code || err.message;
          if (msg !== "fetch failed" && msg !== "UND_ERR_CONNECT_TIMEOUT") {
            log.warn("gateway", `health check error: ${msg}`);
          }
        }
      }
    }
    await sleep(250);
  }
  log.error("gateway", `failed to become ready after ${timeoutMs / 1000} seconds`);
  return false;
}

async function startGateway() {
  if (gatewayProc) return;
  if (!isConfigured()) throw new Error("Gateway cannot start: not configured");

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  const stopResult = await runCmd(OPENCLAW_NODE, clawArgs(["gateway", "stop"]));
  log.info("gateway", `stop existing gateway exit=${stopResult.code}`);

  const args = [
    "gateway",
    "run",
    "--bind",
    "loopback",
    "--port",
    String(INTERNAL_GATEWAY_PORT),
    "--auth",
    "token",
    "--token",
    OPENCLAW_GATEWAY_TOKEN,
    "--allow-unconfigured",
  ];

  gatewayProc = childProcess.spawn(OPENCLAW_NODE, clawArgs(args), {
    stdio: "inherit",
    env: {
      ...process.env,
      OPENCLAW_STATE_DIR: STATE_DIR,
      OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
      DISPLAY: process.env.DISPLAY || ":99",
      CHROME_BIN: process.env.CHROME_BIN || "/usr/local/bin/my247-chromium",
      CHROMIUM_PATH:
        process.env.CHROMIUM_PATH || "/usr/local/bin/my247-chromium",
      BROWSER_PATH: process.env.BROWSER_PATH || "/usr/local/bin/my247-chromium",
      OPENCLAW_BROWSER_PATH:
        process.env.OPENCLAW_BROWSER_PATH || "/usr/local/bin/my247-chromium",
      CHROMIUM_USER_DATA_DIR:
        process.env.CHROMIUM_USER_DATA_DIR ||
        "/data/.openclaw/chromium-profile",
      CHROMIUM_CACHE_DIR:
        process.env.CHROMIUM_CACHE_DIR || "/tmp/chromium-cache",
      XDG_CONFIG_HOME:
        process.env.XDG_CONFIG_HOME || "/data/.openclaw/chromium-config",
      XDG_CACHE_HOME:
        process.env.XDG_CACHE_HOME || "/tmp/chromium-cache",
      XDG_RUNTIME_DIR:
        process.env.XDG_RUNTIME_DIR || "/tmp/runtime-openclaw",
      CHROME_FLAGS:
        process.env.CHROME_FLAGS ||
        "--headless=new --no-sandbox --disable-dev-shm-usage --disable-gpu --disable-setuid-sandbox --disable-software-rasterizer --remote-debugging-port=9222",
      OPENCLAW_BROWSER_ARGS:
        process.env.OPENCLAW_BROWSER_ARGS ||
        "--headless=new --no-sandbox --disable-dev-shm-usage --disable-gpu --disable-setuid-sandbox --disable-software-rasterizer --remote-debugging-port=9222",
    },
  });

  const safeArgs = args.map((arg, i) =>
    args[i - 1] === "--token" ? "[REDACTED]" : arg
  );
  log.info("gateway", `starting with command: ${OPENCLAW_NODE} ${clawArgs(safeArgs).join(" ")}`);
  log.info("gateway", `STATE_DIR: ${STATE_DIR}`);
  log.info("gateway", `WORKSPACE_DIR: ${WORKSPACE_DIR}`);
  log.info("gateway", `config path: ${configPath()}`);

  gatewayProc.on("error", (err) => {
    log.error("gateway", `spawn error: ${String(err)}`);
    gatewayProc = null;
  });

  gatewayProc.on("exit", (code, signal) => {
    log.error("gateway", `exited code=${code} signal=${signal}`);
    gatewayProc = null;
    if (!shuttingDown && isConfigured()) {
      log.info("gateway", "scheduling auto-restart in 2s...");
      setTimeout(() => {
        if (!shuttingDown && !gatewayProc && isConfigured()) {
          ensureGatewayRunning().catch((err) => {
            log.error("gateway", `auto-restart failed: ${err.message}`);
          });
        }
      }, 2000);
    }
  });
}

async function ensureGatewayRunning() {
  if (!isConfigured()) return { ok: false, reason: "not configured" };
  if (gatewayProc) return { ok: true };
  if (!gatewayStarting) {
    gatewayStarting = (async () => {
      await syncAllowedOrigins();
      await startGateway();
      const ready = await waitForGatewayReady({ timeoutMs: 60_000 });
      if (!ready) {
        throw new Error("Gateway did not become ready in time");
      }
    })().finally(() => {
      gatewayStarting = null;
    });
  }
  await gatewayStarting;
  return { ok: true };
}

function isGatewayStarting() {
  return gatewayStarting !== null;
}

function isGatewayReady() {
  return gatewayProc !== null && gatewayStarting === null;
}

async function restartGateway() {
  if (gatewayProc) {
    try {
      gatewayProc.kill("SIGTERM");
    } catch (err) {
      log.warn("gateway", `kill error: ${err.message}`);
    }
    await sleep(750);
    gatewayProc = null;
  }
  return ensureGatewayRunning();
}

const setupRateLimiter = {
  attempts: new Map(),
  windowMs: 60_000,
  maxAttempts: 50,
  cleanupInterval: setInterval(function () {
    const now = Date.now();
    for (const [ip, data] of setupRateLimiter.attempts) {
      if (now - data.windowStart > setupRateLimiter.windowMs) {
        setupRateLimiter.attempts.delete(ip);
      }
    }
  }, 60_000),

  isRateLimited(ip) {
    const now = Date.now();
    const data = this.attempts.get(ip);
    if (!data || now - data.windowStart > this.windowMs) {
      this.attempts.set(ip, { windowStart: now, count: 1 });
      return false;
    }
    data.count++;
    return data.count > this.maxAttempts;
  },
};

function requireSetupAuth(req, res, next) {
  if (!SETUP_PASSWORD) {
    return res
      .status(500)
      .type("text/plain")
      .send(
        "SETUP_PASSWORD is not set. Set it in Railway Variables before using /setup.",
      );
  }

  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  if (setupRateLimiter.isRateLimited(ip)) {
    return res.status(429).type("text/plain").send("Too many requests. Try again later.");
  }

  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) {
    res.set("WWW-Authenticate", 'Basic realm="OpenClaw Setup"');
    return res.status(401).send("Auth required");
  }
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  const password = idx >= 0 ? decoded.slice(idx + 1) : "";
  const passwordHash = crypto.createHash("sha256").update(password).digest();
  const expectedHash = crypto.createHash("sha256").update(SETUP_PASSWORD).digest();
  const isValid = crypto.timingSafeEqual(passwordHash, expectedHash);
  if (!isValid) {
    res.set("WWW-Authenticate", 'Basic realm="OpenClaw Setup"');
    return res.status(401).send("Invalid password");
  }
  return next();
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

app.get("/styles.css", (_req, res) => {
  res.sendFile(path.join(process.cwd(), "src", "public", "styles.css"));
});

app.get("/healthz", async (_req, res) => {
  let gateway = "unconfigured";
  if (isConfigured()) {
    gateway = isGatewayReady() ? "ready" : "starting";
  }
  res.json({ ok: true, gateway });
});

app.get("/setup/healthz", async (_req, res) => {
  const configured = isConfigured();
  const gatewayRunning = isGatewayReady();
  const starting = isGatewayStarting();
  let gatewayReachable = false;

  if (gatewayRunning) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const r = await fetch(`${GATEWAY_TARGET}/`, { signal: controller.signal });
      clearTimeout(timeout);
      gatewayReachable = r !== null;
    } catch {}
  }

  res.json({
    ok: true,
    wrapper: true,
    configured,
    gatewayRunning,
    gatewayStarting: starting,
    gatewayReachable,
  });
});

app.get("/setup", requireSetupAuth, (_req, res) => {
  res.sendFile(path.join(process.cwd(), "src", "public", "setup.html"));
});

app.get("/setup/api/status", requireSetupAuth, async (_req, res) => {
  const { version, channelsHelp } = await getOpenclawInfo();

  const authGroups = [
    {
      value: "openai",
      label: "OpenAI",
      hint: "API key",
      options: [
        { value: "openai-api-key", label: "OpenAI API key" },
      ],
    },
    {
      value: "anthropic",
      label: "Anthropic",
      hint: "API key",
      options: [
        { value: "apiKey", label: "Anthropic API key" },
      ],
    },
    {
      value: "google",
      label: "Google",
      hint: "API key",
      options: [
        { value: "gemini-api-key", label: "Google Gemini API key" },
      ],
    },
    {
      value: "openrouter",
      label: "OpenRouter",
      hint: "API key",
      options: [{ value: "openrouter-api-key", label: "OpenRouter API key" }],
    },
    {
      value: "ai-gateway",
      label: "Vercel AI Gateway",
      hint: "API key",
      options: [
        { value: "ai-gateway-api-key", label: "Vercel AI Gateway API key" },
      ],
    },
    {
      value: "moonshot",
      label: "Moonshot AI",
      hint: "Kimi K2 + Kimi Code",
      options: [
        { value: "moonshot-api-key", label: "Moonshot AI API key" },
        { value: "kimi-code-api-key", label: "Kimi Code API key" },
      ],
    },
    {
      value: "zai",
      label: "Z.AI (GLM 4.7)",
      hint: "API key",
      options: [{ value: "zai-api-key", label: "Z.AI (GLM 4.7) API key" }],
    },
    {
      value: "minimax",
      label: "MiniMax",
      hint: "M2.1 (recommended)",
      options: [
        { value: "minimax-api", label: "MiniMax M2.1" },
        { value: "minimax-api-lightning", label: "MiniMax M2.1 Lightning" },
      ],
    },
    {
      value: "qwen",
      label: "Qwen",
      hint: "OAuth",
      options: [{ value: "qwen-portal", label: "Qwen OAuth" }],
    },
    {
      value: "copilot",
      label: "Copilot",
      hint: "GitHub + local proxy",
      options: [
        {
          value: "github-copilot",
          label: "GitHub Copilot (GitHub device login)",
        },
        { value: "copilot-proxy", label: "Copilot Proxy (local)" },
      ],
    },
    {
      value: "synthetic",
      label: "Synthetic",
      hint: "Anthropic-compatible (multi-model)",
      options: [{ value: "synthetic-api-key", label: "Synthetic API key" }],
    },
    {
      value: "opencode-zen",
      label: "OpenCode Zen",
      hint: "API key",
      options: [
        { value: "opencode-zen", label: "OpenCode Zen (multi-model proxy)" },
      ],
    },
  ];

  res.json({
    configured: isConfigured(),
    gatewayTarget: GATEWAY_TARGET,
    openclawVersion: version,
    channelsAddHelp: channelsHelp,
    authGroups,
    tuiEnabled: ENABLE_WEB_TUI,
  });
});

function buildOnboardArgs(payload) {
  const args = [
    "onboard",
    "--non-interactive",
    "--accept-risk",
    "--json",
    "--no-install-daemon",
    "--skip-health",
    "--workspace",
    WORKSPACE_DIR,
    "--gateway-bind",
    "loopback",
    "--gateway-port",
    String(INTERNAL_GATEWAY_PORT),
    "--gateway-auth",
    "token",
    "--gateway-token",
    OPENCLAW_GATEWAY_TOKEN,
    "--flow",
    "quickstart",
  ];

  if (payload.authChoice) {
    args.push("--auth-choice", payload.authChoice);

    const secret = (payload.authSecret || "").trim();
    const map = {
      "openai-api-key": "--openai-api-key",
      apiKey: "--anthropic-api-key",
      "openrouter-api-key": "--openrouter-api-key",
      "ai-gateway-api-key": "--ai-gateway-api-key",
      "moonshot-api-key": "--moonshot-api-key",
      "kimi-code-api-key": "--kimi-code-api-key",
      "gemini-api-key": "--gemini-api-key",
      "zai-api-key": "--zai-api-key",
      "minimax-api": "--minimax-api-key",
      "minimax-api-lightning": "--minimax-api-key",
      "synthetic-api-key": "--synthetic-api-key",
      "opencode-zen": "--opencode-zen-api-key",
    };
    const flag = map[payload.authChoice];
    if (flag && secret) {
      args.push(flag, secret);
    }

  }

  return args;
}

function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const proc = childProcess.spawn(cmd, args, {
      ...opts,
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: STATE_DIR,
        OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
        DISPLAY: process.env.DISPLAY || ":99",
        CHROME_BIN: process.env.CHROME_BIN || "/usr/local/bin/my247-chromium",
        CHROMIUM_PATH:
          process.env.CHROMIUM_PATH || "/usr/local/bin/my247-chromium",
        BROWSER_PATH:
          process.env.BROWSER_PATH || "/usr/local/bin/my247-chromium",
        OPENCLAW_BROWSER_PATH:
          process.env.OPENCLAW_BROWSER_PATH || "/usr/local/bin/my247-chromium",
        CHROMIUM_USER_DATA_DIR:
          process.env.CHROMIUM_USER_DATA_DIR ||
          "/data/.openclaw/chromium-profile",
        CHROMIUM_CACHE_DIR:
          process.env.CHROMIUM_CACHE_DIR || "/tmp/chromium-cache",
        XDG_CONFIG_HOME:
          process.env.XDG_CONFIG_HOME || "/data/.openclaw/chromium-config",
        XDG_CACHE_HOME:
          process.env.XDG_CACHE_HOME || "/tmp/chromium-cache",
        XDG_RUNTIME_DIR:
          process.env.XDG_RUNTIME_DIR || "/tmp/runtime-openclaw",
        CHROME_FLAGS:
          process.env.CHROME_FLAGS ||
          "--headless=new --no-sandbox --disable-dev-shm-usage --disable-gpu --disable-setuid-sandbox --disable-software-rasterizer --remote-debugging-port=9222",
        OPENCLAW_BROWSER_ARGS:
          process.env.OPENCLAW_BROWSER_ARGS ||
          "--headless=new --no-sandbox --disable-dev-shm-usage --disable-gpu --disable-setuid-sandbox --disable-software-rasterizer --remote-debugging-port=9222",
      },
    });

    let out = "";
    proc.stdout?.on("data", (d) => (out += d.toString("utf8")));
    proc.stderr?.on("data", (d) => (out += d.toString("utf8")));

    proc.on("error", (err) => {
      out += `\n[spawn error] ${String(err)}\n`;
      resolve({ code: 127, output: out });
    });

    proc.on("close", (code) => resolve({ code: code ?? 0, output: out }));
  });
}

const VALID_AUTH_CHOICES = [
  "openai-api-key",
  "apiKey",
  "gemini-api-key",
  "openrouter-api-key",
  "ai-gateway-api-key",
  "moonshot-api-key",
  "kimi-code-api-key",
  "zai-api-key",
  "minimax-api",
  "minimax-api-lightning",
  "qwen-portal",
  "github-copilot",
  "copilot-proxy",
  "synthetic-api-key",
  "opencode-zen",
];

function validatePayload(payload) {
if (payload.authChoice && !VALID_AUTH_CHOICES.includes(payload.authChoice)) {
    return `Invalid authChoice: ${payload.authChoice}`;
  }
  const stringFields = [
    "telegramToken",
    "discordToken",
    "slackBotToken",
    "slackAppToken",
    "authSecret",
    "model",
  ];
  for (const field of stringFields) {
    if (payload[field] !== undefined && typeof payload[field] !== "string") {
      return `Invalid ${field}: must be a string`;
    }
  }
  return null;
}

app.post("/setup/api/run", requireSetupAuth, async (req, res) => {
  try {
    if (isConfigured()) {
      await ensureGatewayRunning();
      return res.json({
        ok: true,
        output:
          "Already configured.\nUse Reset setup if you want to rerun onboarding.\n",
      });
    }

    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

    const payload = req.body || {};
    const validationError = validatePayload(payload);
    if (validationError) {
      return res.status(400).json({ ok: false, output: validationError });
    }
    const onboardArgs = buildOnboardArgs(payload);
    const onboard = await runCmd(OPENCLAW_NODE, clawArgs(onboardArgs));

    let extra = "";
    extra += `\n[setup] Onboarding exit=${onboard.code} configured=${isConfigured()}\n`;

    const ok = onboard.code === 0 && isConfigured();

    if (ok) {
      extra += "\n[setup] Configuring gateway settings...\n";

      const allowInsecureResult = await runCmd(
        OPENCLAW_NODE,
        clawArgs([
          "config",
          "set",
          "gateway.controlUi.allowInsecureAuth",
          "true",
        ]),
      );
      extra += `[config] gateway.controlUi.allowInsecureAuth=true exit=${allowInsecureResult.code}\n`;

      const tokenResult = await runCmd(
        OPENCLAW_NODE,
        clawArgs([
          "config",
          "set",
          "gateway.auth.token",
          OPENCLAW_GATEWAY_TOKEN,
        ]),
      );
      extra += `[config] gateway.auth.token exit=${tokenResult.code}\n`;

      const proxiesResult = await runCmd(
        OPENCLAW_NODE,
        clawArgs([
          "config",
          "set",
          "--json",
          "gateway.trustedProxies",
          '["127.0.0.1"]',
        ]),
      );
      extra += `[config] gateway.trustedProxies exit=${proxiesResult.code}\n`;

      if (payload.model?.trim()) {
        extra += `[setup] Setting model to ${payload.model.trim()}...\n`;
        const modelResult = await runCmd(
          OPENCLAW_NODE,
          clawArgs(["models", "set", payload.model.trim()]),
        );
        extra += `[models set] exit=${modelResult.code}\n${modelResult.output || ""}`;
      }

      async function configureChannel(name, cfgObj) {
        const set = await runCmd(
          OPENCLAW_NODE,
          clawArgs([
            "config",
            "set",
            "--json",
            `channels.${name}`,
            JSON.stringify(cfgObj),
          ]),
        );
        const get = await runCmd(
          OPENCLAW_NODE,
          clawArgs(["config", "get", `channels.${name}`]),
        );
        return (
          `\n[${name} config] exit=${set.code} (output ${set.output.length} chars)\n${set.output || "(no output)"}` +
          `\n[${name} verify] exit=${get.code} (output ${get.output.length} chars)\n${get.output || "(no output)"}`
        );
      }

      if (payload.telegramToken?.trim()) {
        extra += await configureChannel("telegram", {
          enabled: true,
          dmPolicy: "pairing",
          botToken: payload.telegramToken.trim(),
          groupPolicy: "open",
          streamMode: "partial",
        });
      }

      if (payload.discordToken?.trim()) {
        extra += await configureChannel("discord", {
          enabled: true,
          token: payload.discordToken.trim(),
          groupPolicy: "open",
          dm: { policy: "pairing" },
        });
      }

      if (payload.slackBotToken?.trim() || payload.slackAppToken?.trim()) {
        extra += await configureChannel("slack", {
          enabled: true,
          botToken: payload.slackBotToken?.trim() || undefined,
          appToken: payload.slackAppToken?.trim() || undefined,
        });
      }

      extra += "\n[setup] Starting gateway...\n";
      await restartGateway();
      extra += "[setup] Gateway started.\n";
    }

    return res.status(ok ? 200 : 500).json({
      ok,
      output: `${onboard.output}${extra}`,
    });
  } catch (err) {
    log.error("setup", `run error: ${String(err)}`);
    return res
      .status(500)
      .json({ ok: false, output: `Internal error: ${String(err)}` });
  }
});

app.get("/setup/api/debug", requireSetupAuth, async (_req, res) => {
  const v = await runCmd(OPENCLAW_NODE, clawArgs(["--version"]));
  const help = await runCmd(
    OPENCLAW_NODE,
    clawArgs(["channels", "add", "--help"]),
  );
  res.json({
    wrapper: {
      node: process.version,
      port: PORT,
      stateDir: STATE_DIR,
      workspaceDir: WORKSPACE_DIR,
      configPath: configPath(),
      gatewayTokenFromEnv: Boolean(process.env.OPENCLAW_GATEWAY_TOKEN?.trim()),
      gatewayTokenPersisted: fs.existsSync(
        path.join(STATE_DIR, "gateway.token"),
      ),
      railwayCommit: process.env.RAILWAY_GIT_COMMIT_SHA || null,
    },
    openclaw: {
      entry: OPENCLAW_ENTRY,
      node: OPENCLAW_NODE,
      version: v.output.trim(),
      channelsAddHelpIncludesTelegram: help.output.includes("telegram"),
    },
  });
});

app.post("/setup/api/pairing/approve", requireSetupAuth, async (req, res) => {
  const { channel, code } = req.body || {};
  if (!channel || !code) {
    return res
      .status(400)
      .json({ ok: false, error: "Missing channel or code" });
  }
  const r = await runCmd(
    OPENCLAW_NODE,
    clawArgs(["pairing", "approve", String(channel), String(code)]),
  );
  return res
    .status(r.code === 0 ? 200 : 500)
    .json({ ok: r.code === 0, output: r.output });
});

app.post("/setup/api/reset", requireSetupAuth, async (_req, res) => {
  try {
    fs.rmSync(configPath(), { force: true });
    res
      .type("text/plain")
      .send("OK - deleted config file. You can rerun setup now.");
  } catch (err) {
    res.status(500).type("text/plain").send(String(err));
  }
});

app.post("/setup/api/doctor", requireSetupAuth, async (_req, res) => {
  const args = ["doctor", "--non-interactive", "--repair"];
  const result = await runCmd(OPENCLAW_NODE, clawArgs(args));
  return res.status(result.code === 0 ? 200 : 500).json({
    ok: result.code === 0,
    output: result.output,
  });
});

app.get("/setup/api/devices", requireSetupAuth, async (_req, res) => {
  const args = ["devices", "list", "--json", "--token", OPENCLAW_GATEWAY_TOKEN];
  const result = await runCmd(OPENCLAW_NODE, clawArgs(args));
  log.info("devices", `list exit=${result.code} output=${result.output}`);
  try {
    const jsonMatch = result.output.match(/(\{[\s\S]*\}|\[[\s\S]*\])\s*$/);
    if (!jsonMatch) {
      log.warn("devices", "no JSON found in output");
      return res.json({ ok: result.code === 0, raw: result.output });
    }
    const data = JSON.parse(jsonMatch[1]);
    log.info("devices", `parsed keys=${Object.keys(data)} pending=${JSON.stringify(data.pending)} paired=${JSON.stringify(data.paired)}`);
    return res.json({ ok: true, data, raw: result.output });
  } catch (parseErr) {
    log.warn("devices", `JSON parse failed: ${parseErr.message}`);
    return res.json({ ok: result.code === 0, raw: result.output });
  }
});

app.post("/setup/api/devices/approve", requireSetupAuth, async (req, res) => {
  const { requestId } = req.body || {};
  const args = ["devices", "approve"];
  if (requestId) {
    args.push(String(requestId));
  } else {
    args.push("--latest");
  }
  args.push("--token", OPENCLAW_GATEWAY_TOKEN);
  const result = await runCmd(OPENCLAW_NODE, clawArgs(args));
  return res
    .status(result.code === 0 ? 200 : 500)
    .json({ ok: result.code === 0, output: result.output });
});

app.post("/setup/api/devices/reject", requireSetupAuth, async (req, res) => {
  const { requestId } = req.body || {};
  if (!requestId) {
    return res.status(400).json({ ok: false, error: "Missing requestId" });
  }
  const args = [
    "devices", "reject", String(requestId),
    "--token", OPENCLAW_GATEWAY_TOKEN,
  ];
  const result = await runCmd(OPENCLAW_NODE, clawArgs(args));
  return res
    .status(result.code === 0 ? 200 : 500)
    .json({ ok: result.code === 0, output: result.output });
});

function extractJsonFromOutput(output) {
  const jsonMatch = String(output || "").match(/(\{[\s\S]*\}|\[[\s\S]*\])\s*$/);
  if (!jsonMatch) return null;

  try {
    return JSON.parse(jsonMatch[1]);
  } catch {
    return null;
  }
}

async function tryApproveLatestDevice() {
  const listResult = await runCmd(
    OPENCLAW_NODE,
    clawArgs(["devices", "list", "--json", "--token", OPENCLAW_GATEWAY_TOKEN]),
  );

  const data = extractJsonFromOutput(listResult.output);
  const pending = Array.isArray(data?.pending) ? data.pending : [];

  if (pending.length === 0) {
    return {
      approved: false,
      pendingCount: 0,
    };
  }

  log.info(
    "my247-pairing",
    `pending device(s) detected: ${pending.length}; approving latest`,
  );

  const approveResult = await runCmd(
    OPENCLAW_NODE,
    clawArgs(["devices", "approve", "--latest", "--token", OPENCLAW_GATEWAY_TOKEN]),
  );

  log.info(
    "my247-pairing",
    `approve latest exit=${approveResult.code} output=${approveResult.output}`,
  );

  return {
    approved: approveResult.code === 0,
    pendingCount: pending.length,
    output: approveResult.output,
  };
}

function startMy247AutoApproveLoop() {
  if (!MY247_AUTO_APPROVE_FIRST_DEVICE) {
    log.info("my247-pairing", "auto-approve disabled");
    return;
  }

  const maxApprovals = Number.isFinite(MY247_AUTO_APPROVE_MAX_APPROVALS)
    ? Math.max(1, MY247_AUTO_APPROVE_MAX_APPROVALS)
    : 5;

  const intervalMs = Number.isFinite(MY247_AUTO_APPROVE_INTERVAL_MS)
    ? Math.max(1000, MY247_AUTO_APPROVE_INTERVAL_MS)
    : 3000;

  const windowMs = Number.isFinite(MY247_AUTO_APPROVE_WINDOW_MS)
    ? Math.max(0, MY247_AUTO_APPROVE_WINDOW_MS)
    : 0;

  const startedAt = Date.now();
  let approvedCount = 0;
  let stopped = false;
  let timer = null;

  log.info(
    "my247-pairing",
    `auto-approve enabled; maxApprovals=${maxApprovals}; intervalMs=${intervalMs}; windowMs=${windowMs || "none"}`,
  );
  log.info("my247-pairing", "waiting for pending device");

  const stop = () => {
    stopped = true;
    if (timer) clearInterval(timer);
  };

  const tick = async () => {
    if (stopped) return;

    if (windowMs > 0 && Date.now() - startedAt > windowMs) {
      log.info("my247-pairing", "auto-approve window ended");
      stop();
      return;
    }

    try {
      const result = await tryApproveLatestDevice();

      if (result.approved) {
        approvedCount += 1;
        log.info(
          "my247-pairing",
          `approved device ${approvedCount} of ${maxApprovals}`,
        );

        if (approvedCount >= maxApprovals) {
          log.info(
            "my247-pairing",
            "max approvals reached; stopping auto-approve",
          );
          stop();
        }
      }
    } catch (err) {
      log.warn("my247-pairing", `auto-approve attempt failed: ${err.message}`);
    }
  };

  timer = setInterval(tick, intervalMs);
  tick();
}

app.get("/setup/api/export", requireSetupAuth, async (_req, res) => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const zipName = `openclaw-export-${timestamp}.zip`;
  const tmpZip = path.join(os.tmpdir(), zipName);

  try {
    const dirsToExport = [];
    if (fs.existsSync(STATE_DIR)) dirsToExport.push(STATE_DIR);
    if (fs.existsSync(WORKSPACE_DIR)) dirsToExport.push(WORKSPACE_DIR);

    if (dirsToExport.length === 0) {
      return res.status(404).json({ ok: false, error: "No data directories found to export." });
    }

    const zipArgs = ["-r", "-P", SETUP_PASSWORD, tmpZip, ...dirsToExport];
    const result = await runCmd("zip", zipArgs);

    if (result.code !== 0 || !fs.existsSync(tmpZip)) {
      return res.status(500).json({ ok: false, error: "Failed to create export archive.", output: result.output });
    }

    const stat = fs.statSync(tmpZip);
    res.set({
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${zipName}"`,
      "Content-Length": String(stat.size),
    });

    const stream = fs.createReadStream(tmpZip);
    stream.pipe(res);
    stream.on("end", () => {
      try { fs.rmSync(tmpZip, { force: true }); } catch {}
    });
    stream.on("error", (err) => {
      log.error("export", `stream error: ${err.message}`);
      try { fs.rmSync(tmpZip, { force: true }); } catch {}
      if (!res.headersSent) {
        res.status(500).json({ ok: false, error: "Stream error during export." });
      }
    });
  } catch (err) {
    try { fs.rmSync(tmpZip, { force: true }); } catch {}
    log.error("export", `error: ${err.message}`);
    return res.status(500).json({ ok: false, error: `Export failed: ${err.message}` });
  }
});

app.get("/logs", requireSetupAuth, (_req, res) => {
  res.sendFile(path.join(process.cwd(), "src", "public", "logs.html"));
});

app.get("/setup/api/logs", requireSetupAuth, async (_req, res) => {
  try {
    const content = fs.readFileSync(LOG_FILE, "utf8");
    const lines = content.split("\n").filter(Boolean);
    const limit = Math.min(Number.parseInt(_req.query.lines ?? "500", 10), 5000);
    return res.json({ ok: true, lines: lines.slice(-limit) });
  } catch (err) {
    if (err.code === "ENOENT") {
      return res.json({ ok: true, lines: [] });
    }
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/setup/api/logs/stream", requireSetupAuth, (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  for (const line of logRingBuffer) {
    res.write(`data: ${JSON.stringify(line)}\n\n`);
  }

  sseClients.add(res);
  req.on("close", () => {
    sseClients.delete(res);
  });
});

app.get("/tui", requireSetupAuth, (_req, res) => {
  if (!ENABLE_WEB_TUI) {
    return res
      .status(403)
      .type("text/plain")
      .send("Web TUI is disabled. Set ENABLE_WEB_TUI=true to enable it.");
  }
  if (!isConfigured()) {
    return res.redirect("/setup");
  }
  res.sendFile(path.join(process.cwd(), "src", "public", "tui.html"));
});

let activeTuiSession = null;

function verifyTuiAuth(req) {
  if (!SETUP_PASSWORD) return false;
  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) return false;
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  const password = idx >= 0 ? decoded.slice(idx + 1) : "";
  const passwordHash = crypto.createHash("sha256").update(password).digest();
  const expectedHash = crypto.createHash("sha256").update(SETUP_PASSWORD).digest();
  return crypto.timingSafeEqual(passwordHash, expectedHash);
}

function createTuiWebSocketServer(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws, req) => {
    const clientIp = req.socket?.remoteAddress || "unknown";
    log.info("tui", `session started from ${clientIp}`);

    let ptyProcess = null;
    let idleTimer = null;
    let maxSessionTimer = null;

    activeTuiSession = {
      ws,
      pty: null,
      startedAt: Date.now(),
      lastActivity: Date.now(),
    };

    function resetIdleTimer() {
      if (activeTuiSession) {
        activeTuiSession.lastActivity = Date.now();
      }
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        log.info("tui", "session idle timeout");
        ws.close(4002, "Idle timeout");
      }, TUI_IDLE_TIMEOUT_MS);
    }

    function spawnPty(cols, rows) {
      if (ptyProcess) return;

      log.info("tui", `spawning PTY with ${cols}x${rows}`);
      ptyProcess = pty.spawn(OPENCLAW_NODE, clawArgs(["tui"]), {
        name: "xterm-256color",
        cols,
        rows,
        cwd: WORKSPACE_DIR,
        env: {
          ...process.env,
          OPENCLAW_STATE_DIR: STATE_DIR,
          OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
          TERM: "xterm-256color",
        },
      });

      if (activeTuiSession) {
        activeTuiSession.pty = ptyProcess;
      }

      idleTimer = setTimeout(() => {
        log.info("tui", "session idle timeout");
        ws.close(4002, "Idle timeout");
      }, TUI_IDLE_TIMEOUT_MS);

      maxSessionTimer = setTimeout(() => {
        log.info("tui", "max session duration reached");
        ws.close(4002, "Max session duration");
      }, TUI_MAX_SESSION_MS);

      ptyProcess.onData((data) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(data);
        }
      });

      ptyProcess.onExit(({ exitCode, signal }) => {
        log.info("tui", `PTY exited code=${exitCode} signal=${signal}`);
        if (ws.readyState === ws.OPEN) {
          ws.close(1000, "Process exited");
        }
      });
    }

    ws.on("message", (message) => {
      resetIdleTimer();
      try {
        const msg = JSON.parse(message.toString());
        if (msg.type === "resize" && msg.cols && msg.rows) {
          const cols = Math.min(Math.max(msg.cols, 10), 500);
          const rows = Math.min(Math.max(msg.rows, 5), 200);
          if (!ptyProcess) {
            spawnPty(cols, rows);
          } else {
            ptyProcess.resize(cols, rows);
          }
        } else if (msg.type === "input" && msg.data && ptyProcess) {
          ptyProcess.write(msg.data);
        }
      } catch (err) {
        log.warn("tui", `invalid message: ${err.message}`);
      }
    });

    ws.on("close", () => {
      log.info("tui", "session closed");
      clearTimeout(idleTimer);
      clearTimeout(maxSessionTimer);
      if (ptyProcess) {
        try {
          ptyProcess.kill();
        } catch {}
      }
      activeTuiSession = null;
    });

    ws.on("error", (err) => {
      log.error("tui", `WebSocket error: ${err.message}`);
    });
  });

  return wss;
}

const whatsappLinkState = {
  proc: null,
  output: "",
  startedAt: null,
  finishedAt: null,
  exitCode: null,
  error: null,
};

function htmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function sanitizeTerminalOutput(value) {
  return String(value ?? "")
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
    .replace(/\[(?:\d{1,3})(?:;\d{1,3})*m/g, "");
}

function whatsappStatusFromOutput(output) {
  const text = sanitizeTerminalOutput(output);
  const notLinked = /not linked/i.test(text);
  const connected = /linked,\s*running,\s*connected/i.test(text);
  const linked =
    !notLinked &&
    (/enabled,\s*configured,\s*linked/i.test(text) || /\blinked\b/i.test(text));

  return {
    raw: text,
    connected,
    linked,
    notLinked,
    stopped: /stopped/i.test(text),
    disconnected: /disconnected/i.test(text),
    unauthorized: /401|Unauthorized|Connection Failure/i.test(text),
    restartRequired: /515|restart required/i.test(text),
  };
}

async function getWhatsappStatus() {
  const result = await runCmd(OPENCLAW_NODE, clawArgs(["channels", "status"]));
  const parsed = whatsappStatusFromOutput(result.output);
  return {
    ok: result.code === 0,
    code: result.code,
    ...parsed,
  };
}

async function resetWhatsappCredentials() {
  const commands = [
    `${OPENCLAW_NODE} ${clawArgs(["channels", "logout", "--channel", "whatsapp"]).map((x) => JSON.stringify(x)).join(" ")} || true`,
    "rm -rf /data/.openclaw/credentials/whatsapp/default",
    "mkdir -p /data/.openclaw/credentials/whatsapp",
    "chown -R openclaw:openclaw /data/.openclaw/credentials",
    "chmod 700 /data/.openclaw/credentials 2>/dev/null || true",
    "chmod 700 /data/.openclaw/credentials/whatsapp 2>/dev/null || true",
  ];

  const result = await runCmd("bash", ["-lc", commands.join("\n")]);
  return result;
}

function startWhatsappLoginProcess() {
  if (whatsappLinkState.proc) {
    return { alreadyRunning: true };
  }

  whatsappLinkState.output = "";
  whatsappLinkState.startedAt = new Date().toISOString();
  whatsappLinkState.finishedAt = null;
  whatsappLinkState.exitCode = null;
  whatsappLinkState.error = null;

  const loginCommand = [
    "OPENCLAW_STATE_DIR=/data/.openclaw",
    "OPENCLAW_WORKSPACE_DIR=/data/workspace",
    "OPENCLAW_CONFIG_PATH=/data/.openclaw/openclaw.json",
    "HOME=/data",
    OPENCLAW_NODE,
    clawArgs(["channels", "login", "--channel", "whatsapp"]).map((x) => JSON.stringify(x)).join(" "),
  ].join(" ");

  const runAsRoot = typeof process.getuid === "function" && process.getuid() === 0;
  const spawnCmd = runAsRoot ? "su" : "bash";
  const spawnArgs = runAsRoot
    ? ["-s", "/bin/bash", "openclaw", "-c", loginCommand]
    : ["-lc", loginCommand];

  const proc = pty.spawn(spawnCmd, spawnArgs, {
    name: "xterm-color",
    cols: 96,
    rows: 48,
    cwd: process.cwd(),
    env: {
      ...process.env,
      OPENCLAW_STATE_DIR: STATE_DIR,
      OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
      OPENCLAW_CONFIG_PATH: configPath(),
      HOME: "/data",
      TERM: "xterm-256color",
    },
  });

  whatsappLinkState.proc = proc;

  proc.onData((data) => {
    whatsappLinkState.output += sanitizeTerminalOutput(data);
    if (whatsappLinkState.output.length > 80_000) {
      whatsappLinkState.output = whatsappLinkState.output.slice(-80_000);
    }
  });

  proc.onExit(({ exitCode }) => {
    whatsappLinkState.exitCode = exitCode;
    whatsappLinkState.finishedAt = new Date().toISOString();
    whatsappLinkState.proc = null;
  });

  return { alreadyRunning: false };
}

app.get("/my247/whatsapp", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Connect WhatsApp | my24-7assistant</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; background: #f6f7fb; color: #111827; }
    main { max-width: 920px; margin: 0 auto; padding: 32px 18px; }
    .card { background: white; border: 1px solid #e5e7eb; border-radius: 18px; padding: 22px; box-shadow: 0 8px 24px rgba(15,23,42,.06); }
    h1 { margin: 0 0 8px; font-size: 28px; }
    p { line-height: 1.5; }
    button { border: 0; border-radius: 12px; padding: 12px 16px; font-weight: 700; cursor: pointer; margin-right: 8px; margin-top: 8px; }
    .primary { background: #111827; color: white; }
    .secondary { background: #e5e7eb; color: #111827; }
    .danger { background: #fee2e2; color: #991b1b; }
    .status { padding: 10px 12px; border-radius: 12px; background: #f3f4f6; margin: 14px 0; font-weight: 650; }
    .ok { background: #dcfce7; color: #166534; }
    .warn { background: #fef3c7; color: #92400e; }
    .bad { background: #fee2e2; color: #991b1b; }
    pre { background: #020617; color: #e5e7eb; padding: 18px; border-radius: 14px; overflow: auto; white-space: pre-wrap; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 13px; line-height: 1.08; min-height: 220px; }
    ol { padding-left: 22px; }
    .small { color: #6b7280; font-size: 14px; }
  </style>
</head>
<body>
<main>
  <div class="card">
    <h1>Connect your assistant to WhatsApp</h1>
    <p>Use this page instead of the OpenClaw Channels page during beta.</p>
    <ol>
      <li>Click <strong>Start WhatsApp linking</strong>.</li>
      <li>On your phone, open <strong>WhatsApp → Linked Devices → Link a Device</strong>.</li>
      <li>Scan the QR code shown below.</li>
      <li>Wait until this page says <strong>Connected</strong>.</li>
    </ol>

    <div id="status" class="status">Checking status…</div>

    <button class="primary" onclick="startLink()">Start WhatsApp linking</button>
    <!-- Finalise runs automatically after the QR is scanned. -->
    <button class="danger" onclick="resetLink()">Reset WhatsApp link</button>

    <p class="small">If the QR has expired, click Reset, then Start again. Do not use the raw Channels page.</p>

    <h2>QR / setup output</h2>
    <pre id="output">Waiting…</pre>
  </div>
</main>
<script>
async function api(path, options) {
  const res = await fetch(path, options);
  return await res.json();
}

function setStatus(data) {
  const el = document.getElementById("status");
  if (data.connected) {
    el.className = "status ok";
    el.textContent = "WhatsApp connected. You can now message your assistant.";
  } else if (data.linked) {
    el.className = "status warn";
    el.textContent = "WhatsApp linked. Finalising connection…";
  } else {
    el.className = "status";
    el.textContent = "WhatsApp not linked yet. Click Start WhatsApp linking and prepare to scan the QR code.";
  }
}

let finaliseInFlight = false;

async function refresh() {
  try {
    const data = await api("/my247/whatsapp/api/status");
    const status = data.status || {};
    const login = data.login || {};
    const outputEl = document.getElementById("output");

    setStatus(status);

    if (status.connected) {
      outputEl.textContent =
        "WhatsApp connected. You can now message your assistant.\\n\\n" +
        (status.raw || "");
      return;
    }

    outputEl.textContent = login.output || status.raw || "Waiting…";

    const linkedAfterRestart = (login.output || "").includes("Linked after restart");
    if (login.finishedAt && linkedAfterRestart && !finaliseInFlight) {
      await finalize();
    }
  } catch (e) {
    document.getElementById("status").className = "status bad";
    document.getElementById("status").textContent = "Could not check WhatsApp status.";
  }
}

async function startLink() {
  finaliseInFlight = false;
  document.getElementById("output").textContent = "Starting WhatsApp linking…";
  await api("/my247/whatsapp/api/start", { method: "POST" });
  refresh();
}

async function resetLink() {
  if (!confirm("Reset WhatsApp link and remove saved credentials?")) return;
  finaliseInFlight = false;
  document.getElementById("status").className = "status";
  document.getElementById("status").textContent = "Resetting WhatsApp link…";
  document.getElementById("output").textContent = "Resetting WhatsApp link…";
  await api("/my247/whatsapp/api/reset", { method: "POST" });
  document.getElementById("output").textContent =
    "WhatsApp link reset. Click Start WhatsApp linking to generate a new QR.";
  refresh();
}

async function finalize() {
  if (finaliseInFlight) return;
  finaliseInFlight = true;
  document.getElementById("status").className = "status warn";
  document.getElementById("status").textContent = "Finalising WhatsApp connection…";
  try {
    await api("/my247/whatsapp/api/finalize", { method: "POST" });
  } finally {
    finaliseInFlight = false;
  }
  refresh();
}

refresh();
setInterval(refresh, 3000);
</script>
</body>
</html>`);
});

app.get("/my247/whatsapp/api/status", async (_req, res) => {
  try {
    const status = await getWhatsappStatus();
    res.json({
      ok: true,
      status,
      login: {
        running: Boolean(whatsappLinkState.proc),
        output: status.connected
          ? "WhatsApp connected. You can now message your assistant."
          : sanitizeTerminalOutput(whatsappLinkState.output),
        startedAt: whatsappLinkState.startedAt,
        finishedAt: whatsappLinkState.finishedAt,
        exitCode: whatsappLinkState.exitCode,
        error: whatsappLinkState.error,
      },
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/my247/whatsapp/api/reset", async (_req, res) => {
  try {
    if (whatsappLinkState.proc) {
      try { whatsappLinkState.proc.kill(); } catch {}
      whatsappLinkState.proc = null;
    }
    const result = await resetWhatsappCredentials();
    whatsappLinkState.output = "WhatsApp link reset. Click Start WhatsApp linking to generate a new QR.";
    whatsappLinkState.startedAt = null;
    whatsappLinkState.finishedAt = null;
    whatsappLinkState.exitCode = null;
    whatsappLinkState.error = null;
    res.json({ ok: result.code === 0, code: result.code, output: sanitizeTerminalOutput(result.output) });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/my247/whatsapp/api/start", async (_req, res) => {
  try {
    await resetWhatsappCredentials();
    const started = startWhatsappLoginProcess();
    res.json({ ok: true, ...started });
  } catch (error) {
    whatsappLinkState.error = error.message;
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/my247/whatsapp/api/finalize", async (_req, res) => {
  try {
    await runCmd(OPENCLAW_NODE, clawArgs(["gateway", "stop"]));
    gatewayProc = null;
    await ensureGatewayRunning();
    const status = await getWhatsappStatus();
    res.json({ ok: true, status });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});



const proxy = httpProxy.createProxyServer({
  target: GATEWAY_TARGET,
  ws: true,
  xfwd: true,
  changeOrigin: true,
  proxyTimeout: 120_000,
  timeout: 120_000,
});

proxy.on("error", (err, _req, res) => {
  log.error("proxy", String(err));
  if (res && typeof res.headersSent !== "undefined" && !res.headersSent) {
    res.writeHead(503, { "Content-Type": "text/html" });
    try {
      const html = fs.readFileSync(
        path.join(process.cwd(), "src", "public", "loading.html"),
        "utf8",
      );
      res.end(html);
    } catch {
      res.end("Gateway unavailable. Retrying...");
    }
  }
});

const PROXY_ORIGIN = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : GATEWAY_TARGET;

proxy.on("proxyReq", (proxyReq, req, res) => {
  if (!req.url?.startsWith("/hooks/")) {
    proxyReq.setHeader("Authorization", `Bearer ${OPENCLAW_GATEWAY_TOKEN}`);
  }
  proxyReq.setHeader("Origin", PROXY_ORIGIN);
});

proxy.on("proxyReqWs", (proxyReq, req, socket, options, head) => {
  proxyReq.setHeader("Authorization", `Bearer ${OPENCLAW_GATEWAY_TOKEN}`);
  proxyReq.setHeader("Origin", PROXY_ORIGIN);
});

app.use(async (req, res) => {
  if (!isConfigured() && !req.path.startsWith("/setup")) {
    return res.redirect("/setup");
  }

  if (isConfigured()) {
    if (!isGatewayReady()) {
      try {
        await ensureGatewayRunning();
      } catch {
        return res
          .status(503)
          .sendFile(path.join(process.cwd(), "src", "public", "loading.html"));
      }

      if (!isGatewayReady()) {
        return res
          .status(503)
          .sendFile(path.join(process.cwd(), "src", "public", "loading.html"));
      }
    }
  }

  const controlUiEntryPaths = ["/", "/openclaw", "/chat"];
  if (controlUiEntryPaths.includes(req.path)) {
    if (!req.query.my247Tokenized) {
      const targetPath = req.path === "/" ? "/openclaw" : req.path;
      const query = new URLSearchParams();

    for (const [key, value] of Object.entries(req.query)) {
      if (key === "token") continue;

      if (Array.isArray(value)) {
        for (const item of value) query.append(key, item);
      } else if (value !== undefined) {
        query.set(key, String(value));
      }
    }

    query.set("my247Tokenized", "1");

    return res.redirect(
      `${targetPath}?${query.toString()}#token=${encodeURIComponent(
        OPENCLAW_GATEWAY_TOKEN,
      )}`,
    );
  }
}

  return proxy.web(req, res, { target: GATEWAY_TARGET });
});

const server = app.listen(PORT, () => {
  log.info("wrapper", `listening on port ${PORT}`);
  log.info("wrapper", `setup wizard: http://localhost:${PORT}/setup`);
  log.info("wrapper", `web TUI: ${ENABLE_WEB_TUI ? "enabled" : "disabled"}`);
  log.info("wrapper", `configured: ${isConfigured()}`);

  if (isConfigured()) {
    (async () => {
      try {
        log.info("wrapper", "running openclaw doctor --fix...");
        const dr = await runCmd(OPENCLAW_NODE, clawArgs(["doctor", "--fix"]));
        log.info("wrapper", `doctor --fix exit=${dr.code}`);
        if (dr.output) log.info("wrapper", dr.output);
        seedMy247WorkspaceFiles("post-doctor");
      } catch (err) {
        log.warn("wrapper", `doctor --fix failed: ${err.message}`);
      }

      await ensureGatewayRunning();
      startMy247AutoApproveLoop();
    })().catch((err) => {
      log.error("wrapper", `failed to start gateway at boot: ${err.message}`);
    });
  }
});

const tuiWss = createTuiWebSocketServer(server);
server.on("upgrade", async (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/tui/ws") {
    if (!ENABLE_WEB_TUI) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }

    if (!verifyTuiAuth(req)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"OpenClaw TUI\"\r\n\r\n");
      socket.destroy();
      return;
    }

    if (activeTuiSession) {
      socket.write("HTTP/1.1 409 Conflict\r\n\r\n");
      socket.destroy();
      return;
    }

    tuiWss.handleUpgrade(req, socket, head, (ws) => {
      tuiWss.emit("connection", ws, req);
    });
    return;
  }

  if (!isConfigured()) {
    socket.destroy();
    return;
  }
  try {
    await ensureGatewayRunning();
  } catch (err) {
    log.warn("websocket", `gateway not ready: ${err.message}`);
    socket.destroy();
    return;
  }
  proxy.ws(req, socket, head, { target: GATEWAY_TARGET });
});

async function gracefulShutdown(signal) {
  log.info("wrapper", `received ${signal}, shutting down`);
  shuttingDown = true;

  if (setupRateLimiter.cleanupInterval) {
    clearInterval(setupRateLimiter.cleanupInterval);
  }

  if (activeTuiSession) {
    try {
      activeTuiSession.ws.close(1001, "Server shutting down");
      activeTuiSession.pty.kill();
    } catch {}
    activeTuiSession = null;
  }

  server.close();

  if (gatewayProc) {
    try {
      gatewayProc.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => gatewayProc.on("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
      if (gatewayProc && !gatewayProc.killed) {
        gatewayProc.kill("SIGKILL");
      }
    } catch (err) {
      log.warn("wrapper", `error killing gateway: ${err.message}`);
    }
  }

  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
