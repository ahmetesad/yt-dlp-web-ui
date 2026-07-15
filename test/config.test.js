import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../src/config.js";

test("process environment overrides .env and built-in defaults", () => {
  const overrides = {
    APP_PASSWORD: "pipeline-password",
    SESSION_SECRET: "pipeline-session-secret",
    HOST: "0.0.0.0",
    PORT: "4321",
    REQUIRE_PASSWORD: "true",
    SECURE_COOKIES: "1",
    DOWNLOAD_DIR: "/tmp/pipeline-downloads",
    DELETE_AFTER_DOWNLOAD: "0",
    MAX_PLAYLIST_ITEMS: "12",
    DEFAULT_QUALITY: "720"
  };
  const original = Object.fromEntries(
    Object.keys(overrides).map((key) => [key, process.env[key]])
  );

  Object.assign(process.env, overrides);

  try {
    const config = loadConfig();

    assert.equal(config.auth.password, "pipeline-password");
    assert.equal(config.auth.sessionSecret, "pipeline-session-secret");
    assert.equal(config.server.host, "0.0.0.0");
    assert.equal(config.server.port, 4321);
    assert.equal(config.auth.requirePassword, true);
    assert.equal(config.auth.secureCookies, true);
    assert.equal(config.download.downloadDir, "/tmp/pipeline-downloads");
    assert.equal(config.download.deleteAfterDownload, false);
    assert.equal(config.download.maxPlaylistItems, 12);
    assert.equal(config.download.defaultQuality, "720");
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("invalid boolean environment values are rejected", () => {
  const original = process.env.REQUIRE_PASSWORD;
  process.env.REQUIRE_PASSWORD = "sometimes";

  try {
    assert.throws(
      () => loadConfig(),
      /REQUIRE_PASSWORD must be true, false, 1, or 0/
    );
  } finally {
    if (original === undefined) {
      delete process.env.REQUIRE_PASSWORD;
    } else {
      process.env.REQUIRE_PASSWORD = original;
    }
  }
});
