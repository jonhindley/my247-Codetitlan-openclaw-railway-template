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
