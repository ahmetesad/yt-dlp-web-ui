import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

const defaults = {
  host: "127.0.0.1",
  port: 3000,
  maxRequestBytes: 24576,
  loginWindowMinutes: 15,
  loginMaxAttempts: 0,
  downloadWindowMinutes: 10,
  downloadMaxRequests: 0,
  requirePassword: false,
  secureCookies: false,
  sessionDays: 30,
  downloadDir: "./downloads",
  cleanupAfterHours: 6,
  deleteAfterDownload: true,
  deleteAfterDownloadMinutes: 5,
  maxPlaylistItems: 25,
  maxUrlLength: 2048,
  defaultAudioOnly: false,
  defaultFormat: "mp4",
  defaultConvertVideo: "none",
  defaultQuality: "1080",
  defaultIncludePlaylist: false
};

function readEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  const env = {};
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");

    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!key) {
      continue;
    }

    env[key] = value;
  }

  return env;
}

function expectBoolean(value, label) {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`);
  }

  return value;
}

function expectInteger(value, label, minimum) {
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${label} must be an integer >= ${minimum}`);
  }

  return value;
}

function expectString(value, label) {
  if (typeof value !== "string" || !value) {
    throw new Error(`${label} must be a non-empty string`);
  }

  return value;
}

function expectChoice(value, label, choices) {
  if (typeof value !== "string" || !choices.includes(value)) {
    throw new Error(`${label} must be one of: ${choices.join(", ")}`);
  }

  return value;
}

function envString(env, key, fallback) {
  return env[key] === undefined ? fallback : env[key];
}

function envInteger(env, key, fallback) {
  if (env[key] === undefined) {
    return fallback;
  }

  if (!env[key].trim()) {
    return Number.NaN;
  }

  return Number(env[key]);
}

function envBoolean(env, key, fallback) {
  if (env[key] === undefined) {
    return fallback;
  }

  const value = env[key].trim().toLowerCase();

  if (value === "true" || value === "1") {
    return true;
  }

  if (value === "false" || value === "0") {
    return false;
  }

  throw new Error(`${key} must be true, false, 1, or 0`);
}

export function loadConfig() {
  const envPath = path.join(rootDir, ".env");
  // Keep .env convenient locally; deployment environment variables win.
  const env = { ...readEnvFile(envPath), ...process.env };

  const loadedConfig = {
    rootDir,
    publicDir: path.join(rootDir, "public"),
    server: {
      host: expectString(
        envString(env, "HOST", defaults.host),
        "HOST"
      ),
      port: expectInteger(
        envInteger(env, "PORT", defaults.port),
        "PORT",
        1
      ),
      maxRequestBytes: expectInteger(
        envInteger(env, "MAX_REQUEST_BYTES", defaults.maxRequestBytes),
        "MAX_REQUEST_BYTES",
        1024
      )
    },
    rateLimit: {
      loginWindowMinutes: expectInteger(
        envInteger(
          env,
          "LOGIN_WINDOW_MINUTES",
          defaults.loginWindowMinutes
        ),
        "LOGIN_WINDOW_MINUTES",
        1
      ),
      loginMaxAttempts: expectInteger(
        envInteger(env, "LOGIN_MAX_ATTEMPTS", defaults.loginMaxAttempts),
        "LOGIN_MAX_ATTEMPTS",
        0
      ),
      downloadWindowMinutes: expectInteger(
        envInteger(
          env,
          "DOWNLOAD_WINDOW_MINUTES",
          defaults.downloadWindowMinutes
        ),
        "DOWNLOAD_WINDOW_MINUTES",
        1
      ),
      downloadMaxRequests: expectInteger(
        envInteger(
          env,
          "DOWNLOAD_MAX_REQUESTS",
          defaults.downloadMaxRequests
        ),
        "DOWNLOAD_MAX_REQUESTS",
        0
      )
    },
    auth: {
      requirePassword: expectBoolean(
        envBoolean(env, "REQUIRE_PASSWORD", defaults.requirePassword),
        "REQUIRE_PASSWORD"
      ),
      secureCookies: expectBoolean(
        envBoolean(env, "SECURE_COOKIES", defaults.secureCookies),
        "SECURE_COOKIES"
      ),
      sessionDays: expectInteger(
        envInteger(env, "SESSION_DAYS", defaults.sessionDays),
        "SESSION_DAYS",
        1
      ),
      cookieName: "ytdlp_auth",
      password: env.APP_PASSWORD ?? "",
      sessionSecret: env.SESSION_SECRET ?? ""
    },
    download: {
      downloadDir: path.resolve(
        rootDir,
        expectString(
          envString(env, "DOWNLOAD_DIR", defaults.downloadDir),
          "DOWNLOAD_DIR"
        )
      ),
      cleanupAfterHours: expectInteger(
        envInteger(env, "CLEANUP_AFTER_HOURS", defaults.cleanupAfterHours),
        "CLEANUP_AFTER_HOURS",
        1
      ),
      deleteAfterDownload: expectBoolean(
        envBoolean(
          env,
          "DELETE_AFTER_DOWNLOAD",
          defaults.deleteAfterDownload
        ),
        "DELETE_AFTER_DOWNLOAD"
      ),
      deleteAfterDownloadMinutes: expectInteger(
        envInteger(
          env,
          "DELETE_AFTER_DOWNLOAD_MINUTES",
          defaults.deleteAfterDownloadMinutes
        ),
        "DELETE_AFTER_DOWNLOAD_MINUTES",
        1
      ),
      maxPlaylistItems: expectInteger(
        envInteger(env, "MAX_PLAYLIST_ITEMS", defaults.maxPlaylistItems),
        "MAX_PLAYLIST_ITEMS",
        1
      ),
      maxUrlLength: expectInteger(
        envInteger(env, "MAX_URL_LENGTH", defaults.maxUrlLength),
        "MAX_URL_LENGTH",
        128
      ),
      defaultAudioOnly: expectBoolean(
        envBoolean(env, "DEFAULT_AUDIO_ONLY", defaults.defaultAudioOnly),
        "DEFAULT_AUDIO_ONLY"
      ),
      defaultFormat: expectString(
        envString(env, "DEFAULT_FORMAT", defaults.defaultFormat),
        "DEFAULT_FORMAT"
      ),
      defaultConvertVideo: expectChoice(
        envString(
          env,
          "DEFAULT_CONVERT_VIDEO",
          defaults.defaultConvertVideo
        ),
        "DEFAULT_CONVERT_VIDEO",
        ["none", "remux", "h264"]
      ),
      defaultQuality: expectString(
        envString(env, "DEFAULT_QUALITY", defaults.defaultQuality),
        "DEFAULT_QUALITY"
      ),
      defaultIncludePlaylist: expectBoolean(
        envBoolean(
          env,
          "DEFAULT_INCLUDE_PLAYLIST",
          defaults.defaultIncludePlaylist
        ),
        "DEFAULT_INCLUDE_PLAYLIST"
      )
    }
  };

  if (
    loadedConfig.auth.requirePassword &&
    (!loadedConfig.auth.password ||
      loadedConfig.auth.sessionSecret.length < 16)
  ) {
    throw new Error(
      "Password auth is enabled, but APP_PASSWORD or a 16+ character SESSION_SECRET is missing from the environment or .env"
    );
  }

  return loadedConfig;
}
