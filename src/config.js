import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in ${filePath}: ${error.message}`);
  }
}

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

function expectObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }

  return value;
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

export function loadConfig() {
  const configPath = path.join(rootDir, "config.json");
  const envPath = path.join(rootDir, ".env");
  const config = readJson(configPath);
  const env = readEnvFile(envPath);

  const server = expectObject(config.server, "config.server");
  const auth = expectObject(config.auth, "config.auth");
  const download = expectObject(config.download, "config.download");

  const loadedConfig = {
    rootDir,
    publicDir: path.join(rootDir, "public"),
    server: {
      host: expectString(server.host, "config.server.host"),
      port: expectInteger(server.port, "config.server.port", 1),
      maxRequestBytes: expectInteger(
        server.maxRequestBytes,
        "config.server.maxRequestBytes",
        1024
      )
    },
    auth: {
      requirePassword: expectBoolean(
        auth.requirePassword,
        "config.auth.requirePassword"
      ),
      secureCookies: expectBoolean(
        auth.secureCookies,
        "config.auth.secureCookies"
      ),
      sessionDays: expectInteger(auth.sessionDays, "config.auth.sessionDays", 1),
      cookieName: "ytdlp_auth",
      password: env.APP_PASSWORD || "",
      sessionSecret: env.SESSION_SECRET || ""
    },
    download: {
      downloadDir: path.resolve(
        rootDir,
        expectString(download.downloadDir, "config.download.downloadDir")
      ),
      cleanupAfterHours: expectInteger(
        download.cleanupAfterHours,
        "config.download.cleanupAfterHours",
        1
      ),
      maxPlaylistItems: expectInteger(
        download.maxPlaylistItems,
        "config.download.maxPlaylistItems",
        1
      ),
      maxUrlLength: expectInteger(
        download.maxUrlLength,
        "config.download.maxUrlLength",
        128
      ),
      defaultAudioOnly: expectBoolean(
        download.defaultAudioOnly,
        "config.download.defaultAudioOnly"
      ),
      defaultFormat: expectString(
        download.defaultFormat,
        "config.download.defaultFormat"
      ),
      defaultQuality: expectString(
        download.defaultQuality,
        "config.download.defaultQuality"
      ),
      defaultIncludePlaylist: expectBoolean(
        download.defaultIncludePlaylist,
        "config.download.defaultIncludePlaylist"
      )
    }
  };

  if (
    loadedConfig.auth.requirePassword &&
    (!loadedConfig.auth.password ||
      loadedConfig.auth.sessionSecret.length < 16)
  ) {
    throw new Error(
      "Password auth is enabled, but APP_PASSWORD or a 16+ character SESSION_SECRET is missing in .env"
    );
  }

  return loadedConfig;
}
