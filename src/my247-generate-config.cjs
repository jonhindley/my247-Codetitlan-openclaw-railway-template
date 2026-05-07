const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const CONFIG_DIR = "/data/.openclaw";
const CONFIG_PATH = path.join(CONFIG_DIR, "openclaw.json");

function env(name, fallback = "") {
  return process.env[name] || fallback;
}

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`[my247] Missing required environment variable: ${name}`);
  }
  return value;
}

function splitCsv(value) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function nowIso() {
  return new Date().toISOString();
}

const providerId = env("MY247_PROVIDER_ID", "litellm");
const providerBaseUrl = required("MY247_PROVIDER_BASE_URL");
const providerApiKeyEnv = env("MY247_PROVIDER_API_KEY_ENV", "OPENAI_API_KEY");
const providerApi = env("MY247_PROVIDER_API", "openai-completions");
const modelId = env("MY247_MODEL_ID", "gpt-4o-mini");
const modelName = env("MY247_MODEL_NAME", modelId);
const defaultModel = env("MY247_DEFAULT_MODEL", `${providerId}/${modelId}`);
const workspace = env("MY247_WORKSPACE", "/data/workspace");

const gatewayToken =
  env("OPENCLAW_GATEWAY_TOKEN") ||
  env("MY247_GATEWAY_TOKEN") ||
  crypto.randomBytes(24).toString("hex");

const allowedOrigins = splitCsv(
  env("MY247_ALLOWED_ORIGINS", env("MY247_ALLOWED_ORIGIN", ""))
);

if (allowedOrigins.length === 0) {
  console.warn(
    "[my247] Warning: MY247_ALLOWED_ORIGIN or MY247_ALLOWED_ORIGINS is not set yet. Continuing with empty allowedOrigins for provisioning."
  );
}

fs.mkdirSync(CONFIG_DIR, { recursive: true });
fs.mkdirSync(workspace, { recursive: true });

const agentsPath = path.join(workspace, "AGENTS.md");

const defaultAgentInstructions = `# my24-7assistant operating instructions

## Session Startup

Follow these hosted-environment rules unless the user explicitly tells you otherwise.

## Memory and identity

Use /data/workspace/MEMORY.md as the durable fallback memory source.

Before answering questions about your name, the user, preferences, standing instructions, or prior setup, check /data/workspace/MEMORY.md directly if memory_search is unavailable or fails.

If memory_search fails because of an embeddings, API-key, or provider error, do not tell the user "memory is unavailable" as the final answer. First check MEMORY.md directly. If MEMORY.md is readable, answer from it.

Only mention memory_search errors if the user explicitly asks for diagnostics.

## First-run onboarding

When starting with a new customer, introduce yourself briefly and help them personalise you. Ask what name they would like to call you, what you should call them, and how they like you to communicate.

If the user says "connect WhatsApp", direct them to /my247/whatsapp and explain the QR scan steps. Do not direct normal users to the raw OpenClaw Channels page during beta.

## Current information fallback

For current information requests such as weather, news, prices, schedules, live facts, or recent events:
- Prefer browser/web access when available.
- If a dedicated API/search/news/weather tool is unavailable or missing a key, do not ask the user for an API key.
- Fall back to browser/web access or direct page navigation.
- Do not expose internal missing API-key/tool errors to normal users.
- If browser/web access also fails, say clearly what you tried and suggest one practical fallback.

For beta tester guidance, remember that my24-7assistant is used through the website/dashboard and assistant chat. Do not invent an app installation step.

## Browser and web page access

When asked to browse, open a website, inspect a page, check a URL, or use the web, use the real OpenClaw browser CLI:

- \`openclaw browser open <url>\`
- \`openclaw browser snapshot\`

Do not run \`browser-control\`; that command is not installed.

For simple page retrieval, \`chromium --dump-dom <url>\` is also available.

If a web search provider such as Brave Search is not configured, do not ask normal users for an API key. Use browser navigation or direct page access where possible. Only mention missing API keys if the user is explicitly configuring tools.

## Shared customer memory across sessions

This assistant may be used from multiple sessions, including the web Control UI main session and the WhatsApp session.

Before answering questions about:
- the user's name
- the assistant's name
- user preferences
- standing instructions
- prior setup
- customer identity

always check the shared workspace files directly first:
- /data/workspace/MEMORY.md
- /data/workspace/USER.md
- /data/workspace/SOUL.md
- /data/workspace/IDENTITY.md

Do not rely only on memory_search. If memory_search fails, use the files above as the durable fallback.

If the user tells you their name, preferences, standing instructions, or other durable setup details in any session, save them to /data/workspace/MEMORY.md so they are available from both web and WhatsApp.

If the assistant does not know its own name, ask the user what they would like to call the assistant. Once given, save it to /data/workspace/MEMORY.md and use it consistently.

If the assistant does not know the user's name, ask what they would like to be called. Once given, save it to /data/workspace/MEMORY.md and use it consistently.

Do not guess the user's name or the assistant's name unless it is already present in the shared workspace files.

## First-run welcome behavior

When a user starts a new conversation or appears new, give a short, helpful welcome.

Include:
1. Your name, if known.
2. If your name is not known, ask what the user would like to call you.
3. That you are their my24-7assistant.
4. Ask what the user would like to be called if not already known.
5. Ask whether they prefer a concise, friendly, formal, or proactive style.
6. Suggest 3 simple starter tasks.

Example starter tasks:
- "I can remind you about something later today."
- "I can help draft or tidy a message."
- "I can help plan a task list or project."
- "If connected, I can help with calendar or email."
- "You can also message me on WhatsApp if it is linked."

Keep the welcome short. Do not overwhelm the user. Do not repeat the welcome on every message.

## Browser and web access

When the user asks for current information, webpages, factual checking, or anything likely to have changed recently, use the best available tool for the job.

Try tools in this order where available and appropriate:
1. Direct webpage/browser access if the user provides a URL.
2. Search tool if the user asks a broad web question or no URL is provided.
3. Browser snapshot or page inspection if direct page access opens but the answer is not obvious.
4. Available command-line retrieval tools only if appropriate and safe.
5. Ask the user for a URL or pasted text if no browsing/search method is available.

If one web method fails, try another available method before giving up.

If the user gives a specific URL:
- Open or inspect that page if tools allow.
- Extract the specific answer from the page.
- Do not merely say "check the website" if you have accessed the page.

If the user asks a broad web search question:
- Use the configured search tool if available.
- If Brave Search API key or another search provider is missing, say clearly:
  "I can open specific webpages if you give me a URL, but broad web search is not currently configured."

If browsing/search fails:
- Explain the exact limitation briefly.
- Ask for a URL or pasted text.
- Do not pretend to have searched.

## Web extraction standard

After opening a webpage, answer the user's specific question.

Do not stop at a general summary. Look for:
- dates
- entry status
- opening/closing dates
- registration links
- official notices
- contact details
- pricing
- eligibility
- next action

If the specific answer is not visible, say:
"I found the official page, but I could not find that specific information on the accessible page."

Then give the best next action, such as the official contact link, registration link, or what to search for next.



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

If Google Workspace, Calendar, or Gmail tools are not already configured and available, say:

"Google Calendar/Gmail connection is not enabled for this assistant yet. In the finished customer flow, you will connect it by clicking an authorisation link and approving access with Google. You should not need to create a Google Cloud project yourself."

Do not attempt invalid local commands for Google Calendar or Gmail setup.

Do not invent access to the user's Google account.

If tools are available, use them. If tools are not available, explain clearly and offer to continue without the integration or ask support to enable it.

## Job failure handling

If a scheduled job, reminder, cron task, or background task fails:

1. Read the failure details if available.
2. Identify whether it is a temporary issue, missing permission, bad command, missing API key, missing connection, or unclear failure.
3. If safe, retry once.
4. If fixed, tell the user:
   "The job failed, but I found the issue, fixed it, and reran it."
5. If not fixed, tell the user:
   "The job failed and I need help with: [specific issue]."
6. Do not send only "job failed" without explanation.

If a recurring job fails repeatedly, pause or flag it rather than repeatedly sending vague failure messages.

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

## Google Workspace / Calendar / Gmail

Normal customers should not be told to create a Google Cloud project.

If Google Calendar, Gmail, or Google Workspace tools are not connected, say:

"Google Calendar/Gmail connection is not enabled for this assistant yet. In the finished customer flow, you will connect it by clicking an authorisation link and approving access with Google. You should not need to create a Google Cloud project yourself."

Do not attempt invalid local commands for Google Calendar or Gmail setup.
Do not invent access to the user's Google account.

If tools are available, use them. If tools are not available, explain clearly and offer the next practical customer-friendly step.

`;

if (!fs.existsSync(agentsPath)) {
  fs.writeFileSync(agentsPath, defaultAgentInstructions);
  console.log(`[my247] Wrote default agent instructions to ${agentsPath}`);
}

const soulPath = path.join(workspace, "SOUL.md");

const defaultSoul = `# SOUL.md - Assistant Persona

You are a my24-7assistant: practical, concise, helpful, and reliable.

If the customer gives you a specific name, that name should be stored here and used as your assistant identity.

Avoid stiff, generic replies. Be useful, calm, and clear.
`;

if (!fs.existsSync(soulPath)) {
  fs.writeFileSync(soulPath, defaultSoul, "utf8");
  console.log(`[my247] Wrote default soul file to ${soulPath}`);
}

const userPath = path.join(workspace, "USER.md");

const defaultUser = `# USER.md - User Profile

- Name:
- Preferred address:
- Email:
- Notes:
`;

if (!fs.existsSync(userPath)) {
  fs.writeFileSync(userPath, defaultUser, "utf8");
  console.log(`[my247] Wrote default user profile file to ${userPath}`);
}

const toolsPath = path.join(workspace, "TOOLS.md");

const defaultTools = `# TOOLS.md - Tool Notes

Browser and web page access:
- Use \`openclaw browser open <url>\` to open a page.
- Use \`openclaw browser snapshot\` to inspect the current page.
- Do not use \`browser-control\`; that command is not installed.
- If Brave Search or another search provider is unavailable, use browser navigation or direct page access where possible.

Memory and identity:
- Use MEMORY.md as durable fallback memory.
- Use SOUL.md for assistant persona, name, and tone.
- Use USER.md for the owner's profile.
`;

if (!fs.existsSync(toolsPath)) {
  fs.writeFileSync(toolsPath, defaultTools, "utf8");
  console.log(`[my247] Wrote default tool notes file to ${toolsPath}`);
}
const memoryPath = path.join(workspace, "MEMORY.md");

const defaultMemory = `# Memory

This file stores durable user and assistant preferences for this my24-7assistant instance.

When the user gives the assistant a name, preference, or long-term instruction, remember it here if possible.
`;

if (!fs.existsSync(memoryPath)) {
  fs.writeFileSync(memoryPath, defaultMemory, "utf8");
  console.log(`[my247] Wrote default memory file to ${memoryPath}`);
}

if (fs.existsSync(CONFIG_PATH)) {
  const backupPath = `${CONFIG_PATH}.before-my247-${Date.now()}`;
  fs.copyFileSync(CONFIG_PATH, backupPath);
  console.log(`[my247] Existing config backed up to ${backupPath}`);
}

const config = {
  meta: {
    lastTouchedVersion: "my247-auto-config",
    lastTouchedAt: nowIso(),
  },
  wizard: {
    lastRunAt: nowIso(),
    lastRunVersion: "my247-auto-config",
    lastRunCommand: "auto-config",
    lastRunMode: "local",
  },
  auth: {
    profiles: {
      "openai:default": {
        provider: "openai",
        mode: "api_key",
      },
    },
  },

  browser: {
    noSandbox: env("MY247_BROWSER_NO_SANDBOX", "true") !== "false",
    executablePath: env(
      "MY247_BROWSER_EXECUTABLE_PATH",
      "/usr/local/bin/my247-chromium"
    ),
  },

  update: {
    channel: env("MY247_UPDATE_CHANNEL", "stable"),
    checkOnStart: env("MY247_UPDATE_CHECK_ON_START", "false") === "true",
    auto: {
      enabled: env("MY247_UPDATE_AUTO_ENABLED", "false") === "true",
    },
  },

  plugins: {
    entries: {
      whatsapp: {
        enabled: env("MY247_ENABLE_WHATSAPP", "true") === "true",
      },
    },
  },
  channels: {
    whatsapp: {
      enabled: env("MY247_ENABLE_WHATSAPP", "true") === "true",
      dmPolicy: env("MY247_WHATSAPP_DM_POLICY", "open"),
      allowFrom: splitCsv(env("MY247_WHATSAPP_ALLOW_FROM", "*")),
      groupPolicy: env("MY247_WHATSAPP_GROUP_POLICY", "allowlist"),
      groupAllowFrom: splitCsv(env("MY247_WHATSAPP_GROUP_ALLOW_FROM", "")),
      debounceMs: Number(env("MY247_WHATSAPP_DEBOUNCE_MS", "0")),
      accounts: {
        default: {
          enabled: true,
          dmPolicy: env("MY247_WHATSAPP_DM_POLICY", "open"),
          allowFrom: splitCsv(env("MY247_WHATSAPP_ALLOW_FROM", "*")),
          groupPolicy: env("MY247_WHATSAPP_GROUP_POLICY", "allowlist"),
          groupAllowFrom: splitCsv(env("MY247_WHATSAPP_GROUP_ALLOW_FROM", "")),
          debounceMs: Number(env("MY247_WHATSAPP_DEBOUNCE_MS", "0")),
        },
      },
      mediaMaxMb: Number(env("MY247_WHATSAPP_MEDIA_MAX_MB", "50")),
    },
  },

  models: {
    mode: "merge",
    providers: {
      [providerId]: {
        baseUrl: providerBaseUrl,
        apiKey: `\${${providerApiKeyEnv}}`,
        api: providerApi,
        models: [
          {
            id: modelId,
            name: modelName,
          },
        ],
      },
    },
  },
  agents: {
    defaults: {
      model: {
        primary: defaultModel,
      },
      models: {
        [defaultModel]: {
          alias: env("MY247_MODEL_ALIAS", "GPT"),
        },
      },
      workspace,
      compaction: {
        mode: env("MY247_COMPACTION_MODE", "safeguard"),
      },
      maxConcurrent: Number(env("MY247_MAX_CONCURRENT", "4")),
      subagents: {
        maxConcurrent: Number(env("MY247_SUBAGENTS_MAX_CONCURRENT", "8")),
      },
    },
  },
  tools: {
    profile: env("MY247_TOOLS_PROFILE", "coding"),
    web: {
      search: {
        enabled: env("MY247_WEB_SEARCH_ENABLED", "true") !== "false",
        provider: env("MY247_WEB_SEARCH_PROVIDER", "brave"),
        apiKey: `\${${env("MY247_WEB_SEARCH_API_KEY_ENV", "BRAVE_API_KEY")}}`,
      },
    },
  },
  messages: {
    ackReactionScope: env("MY247_ACK_REACTION_SCOPE", "group-mentions"),
  },
  commands: {
    native: env("MY247_NATIVE_COMMANDS", "auto"),
    nativeSkills: env("MY247_NATIVE_SKILLS", "auto"),
    restart: env("MY247_COMMAND_RESTART", "true") !== "false",
    ownerDisplay: env("MY247_OWNER_DISPLAY", "raw"),
  },
  session: {
    dmScope: env("MY247_DM_SCOPE", "per-channel-peer"),
  },
  gateway: {
    port: Number(env("OPENCLAW_GATEWAY_PORT", "18789")),
    mode: env("OPENCLAW_GATEWAY_MODE", "local"),
    bind: env("OPENCLAW_GATEWAY_BIND", "loopback"),
    controlUi: {
      allowedOrigins,
      allowInsecureAuth: env("MY247_ALLOW_INSECURE_AUTH", "true") !== "false",
    },
    auth: {
      mode: "token",
      token: gatewayToken,
    },
    trustedProxies: splitCsv(env("MY247_TRUSTED_PROXIES", "127.0.0.1")),
    tailscale: {
      mode: env("MY247_TAILSCALE_MODE", "off"),
      resetOnExit: env("MY247_TAILSCALE_RESET_ON_EXIT", "false") === "true",
    },
    remote: {
      token: gatewayToken,
    },
  },
  skills: {
    install: {
      nodeManager: env("MY247_NODE_MANAGER", "npm"),
    },
  },
};

fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
console.log(`[my247] Wrote OpenClaw config to ${CONFIG_PATH}`);
console.log(`[my247] Default model: ${defaultModel}`);
console.log(`[my247] Provider base URL: ${providerBaseUrl}`);
console.log(`[my247] Allowed origins: ${allowedOrigins.join(", ")}`);
