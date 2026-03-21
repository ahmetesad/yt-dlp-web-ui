import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAppServer } from "../src/app-server.js";

function createTestConfig(downloadDir, overrides = {}) {
  const baseConfig = {
    publicDir: path.resolve(process.cwd(), "public"),
    rateLimit: {
      downloadMaxRequests: 0,
      downloadWindowMinutes: 10,
      loginMaxAttempts: 0,
      loginWindowMinutes: 15
    },
    auth: {
      cookieName: "ytdlp_auth",
      password: "",
      requirePassword: false,
      secureCookies: false,
      sessionDays: 30,
      sessionSecret: "0123456789abcdef0123456789abcdef"
    },
    server: {
      host: "127.0.0.1",
      maxRequestBytes: 24576,
      port: 0
    },
    download: {
      cleanupAfterHours: 6,
      defaultAudioOnly: false,
      defaultFormat: "mp4",
      defaultIncludePlaylist: false,
      defaultRemuxVideo: "none",
      defaultQuality: "1080",
      downloadDir,
      maxPlaylistItems: 25,
      maxUrlLength: 2048
    }
  };

  return {
    ...baseConfig,
    ...overrides,
    auth: {
      ...baseConfig.auth,
      ...(overrides.auth || {})
    },
    download: {
      ...baseConfig.download,
      ...(overrides.download || {})
    },
    rateLimit: {
      ...baseConfig.rateLimit,
      ...(overrides.rateLimit || {})
    },
    server: {
      ...baseConfig.server,
      ...(overrides.server || {})
    }
  };
}

async function startServer(t, options = {}) {
  const downloadDir = await fs.mkdtemp(path.join(os.tmpdir(), "ytdlp-web-ui-"));
  const config = createTestConfig(downloadDir, options.config);
  const app = createAppServer({
    config,
    downloadExecutor: options.downloadExecutor,
    jobTtlMs: options.jobTtlMs
  });

  await new Promise((resolve) => {
    app.server.listen(0, "127.0.0.1", resolve);
  });

  const address = app.server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  t.after(async () => {
    const closePromise = app.close().catch(() => {
      return;
    });
    app.server.closeIdleConnections?.();
    app.server.closeAllConnections?.();
    await closePromise;
    await fs.rm(downloadDir, {
      force: true,
      recursive: true
    });
  });

  return {
    baseUrl,
    config,
    ...app
  };
}

async function requestJson(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const text = await response.text();
  let payload = null;

  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  return {
    payload,
    response
  };
}

function openSse(baseUrl, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(`${baseUrl}${pathname}`, { headers }, (response) => {
      response.setEncoding("utf8");
      resolve({ request, response });
    });

    request.on("error", reject);
    request.end();
  });
}

function waitForSseEvents(response, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const events = [];
    let settled = false;
    const timer = setTimeout(() => {
      finish(new Error("Timed out waiting for SSE events."));
    }, timeoutMs);

    function finish(error) {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      response.off("close", handleClose);
      response.off("data", handleData);
      response.off("error", handleError);

      if (error) {
        reject(error);
        return;
      }

      resolve(events);
    }

    function parseBlock(block) {
      if (!block.trim() || block.startsWith(":")) {
        return null;
      }

      let eventName = "message";
      let data = "";

      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) {
          eventName = line.slice(6).trim();
          continue;
        }

        if (line.startsWith("data:")) {
          data += line.slice(5).trim();
        }
      }

      let payload = null;

      if (data) {
        try {
          payload = JSON.parse(data);
        } catch {
          payload = data;
        }
      }

      if (!data && eventName === "message") {
        return null;
      }

      return {
        event: eventName,
        payload
      };
    }

    function drainBuffer() {
      while (buffer.includes("\n\n")) {
        const boundaryIndex = buffer.indexOf("\n\n");
        const block = buffer.slice(0, boundaryIndex);
        buffer = buffer.slice(boundaryIndex + 2);
        const event = parseBlock(block);

        if (!event) {
          continue;
        }

        events.push(event);

        if (predicate(events)) {
          finish();
          return;
        }
      }
    }

    function handleClose() {
      if (!settled && !predicate(events)) {
        finish(new Error("SSE closed before the expected events arrived."));
      }
    }

    function handleData(chunk) {
      buffer += chunk;
      drainBuffer();
    }

    function handleError(error) {
      finish(error);
    }

    response.on("close", handleClose);
    response.on("data", handleData);
    response.on("error", handleError);
  });
}

function createControlledExecutor() {
  let currentJobId = "";
  let onProgress = null;
  let resolveResult;
  let rejectResult;
  let startedResolve;

  const started = new Promise((resolve) => {
    startedResolve = resolve;
  });
  const pendingResult = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  return {
    complete(files) {
      resolveResult({
        files,
        jobId: currentJobId
      });
    },
    emit(progress) {
      onProgress?.(progress);
    },
    executor: async ({ jobId, onProgress: nextOnProgress }) => {
      currentJobId = jobId;
      onProgress = nextOnProgress;
      onProgress({
        downloadedBytes: 1024,
        etaSeconds: 10,
        message: "Starting download...",
        percent: 3,
        phase: "downloading",
        totalBytes: 4096
      });
      startedResolve(jobId);
      return pendingResult;
    },
    fail(error) {
      rejectResult(error);
    },
    get jobId() {
      return currentJobId;
    },
    started
  };
}

test("POST /api/download creates a job and snapshots reflect progress", async (t) => {
  const controller = createControlledExecutor();
  const app = await startServer(t, {
    downloadExecutor: controller.executor
  });

  const createResponse = await requestJson(app.baseUrl, "/api/download", {
    body: JSON.stringify({
      format: "mp4",
      mediaUrl: "https://1.1.1.1/watch?v=test",
      quality: "1080"
    }),
    headers: {
      "Content-Type": "application/json"
    },
    method: "POST"
  });

  assert.equal(createResponse.response.status, 202);
  assert.match(createResponse.payload.jobId, /^[a-f0-9]{24}$/);
  assert.equal(createResponse.payload.status, "queued");

  await controller.started;

  const runningSnapshot = await requestJson(
    app.baseUrl,
    `/api/jobs/${createResponse.payload.jobId}`
  );

  assert.equal(runningSnapshot.response.status, 200);
  assert.equal(runningSnapshot.payload.status, "running");
  assert.equal(runningSnapshot.payload.progress.message, "Starting download...");

  controller.emit({
    downloadedBytes: null,
    etaSeconds: null,
    message: "Processing media...",
    percent: 82,
    phase: "postprocessing",
    totalBytes: null
  });

  const processingSnapshot = await requestJson(
    app.baseUrl,
    `/api/jobs/${createResponse.payload.jobId}`
  );

  assert.equal(processingSnapshot.response.status, 200);
  assert.equal(processingSnapshot.payload.status, "postprocessing");
  assert.equal(processingSnapshot.payload.progress.phase, "postprocessing");

  controller.complete([
    {
      name: "clip.mp4",
      size: 2048,
      url: `/api/downloads/${createResponse.payload.jobId}/clip.mp4`
    }
  ]);

  await new Promise((resolve) => {
    setTimeout(resolve, 25);
  });

  const completeSnapshot = await requestJson(
    app.baseUrl,
    `/api/jobs/${createResponse.payload.jobId}`
  );

  assert.equal(completeSnapshot.response.status, 200);
  assert.equal(completeSnapshot.payload.status, "completed");
  assert.equal(completeSnapshot.payload.files.length, 1);
  assert.equal(completeSnapshot.payload.files[0].name, "clip.mp4");
});

test("job SSE sends snapshot, progress, then complete", async (t) => {
  const controller = createControlledExecutor();
  const app = await startServer(t, {
    downloadExecutor: controller.executor
  });

  const createResponse = await requestJson(app.baseUrl, "/api/download", {
    body: JSON.stringify({
      format: "mp4",
      mediaUrl: "https://1.1.1.1/watch?v=test",
      quality: "1080"
    }),
    headers: {
      "Content-Type": "application/json"
    },
    method: "POST"
  });

  const jobId = createResponse.payload.jobId;
  await controller.started;

  const stream = await openSse(app.baseUrl, `/api/jobs/${jobId}/events`);

  t.after(() => {
    stream.request.destroy();
    stream.response.destroy();
  });

  setTimeout(() => {
    controller.emit({
      downloadedBytes: null,
      etaSeconds: null,
      message: "Processing media...",
      percent: 84,
      phase: "postprocessing",
      totalBytes: null
    });
    controller.complete([
      {
        name: "clip.mp4",
        size: 2048,
        url: `/api/downloads/${jobId}/clip.mp4`
      }
    ]);
  }, 40);

  const events = await waitForSseEvents(
    stream.response,
    (receivedEvents) => receivedEvents.some((event) => event.event === "complete")
  );

  assert.equal(stream.response.statusCode, 200);
  assert.equal(events[0].event, "snapshot");
  assert.ok(events.some((event) => event.event === "progress"));
  assert.equal(events.at(-1).event, "complete");
});

test("auth-protected snapshot, events, and downloads require a valid cookie", async (t) => {
  const controller = createControlledExecutor();
  const app = await startServer(t, {
    config: {
      auth: {
        password: "letmein",
        requirePassword: true
      }
    },
    downloadExecutor: controller.executor
  });

  const blockedSnapshot = await requestJson(app.baseUrl, `/api/jobs/${"a".repeat(24)}`);
  const blockedEvents = await requestJson(
    app.baseUrl,
    `/api/jobs/${"a".repeat(24)}/events`
  );

  await fs.mkdir(path.join(app.config.download.downloadDir, "a".repeat(24)), {
    recursive: true
  });
  await fs.writeFile(
    path.join(app.config.download.downloadDir, "a".repeat(24), "clip.mp4"),
    "test file"
  );

  const blockedDownload = await requestJson(
    app.baseUrl,
    `/api/downloads/${"a".repeat(24)}/clip.mp4`
  );

  assert.equal(blockedSnapshot.response.status, 401);
  assert.equal(blockedEvents.response.status, 401);
  assert.equal(blockedDownload.response.status, 401);

  const loginResponse = await requestJson(app.baseUrl, "/api/auth/login", {
    body: JSON.stringify({ password: "letmein" }),
    headers: {
      "Content-Type": "application/json"
    },
    method: "POST"
  });
  const cookie = loginResponse.response.headers.get("set-cookie");

  assert.equal(loginResponse.response.status, 200);
  assert.ok(cookie);

  const createResponse = await requestJson(app.baseUrl, "/api/download", {
    body: JSON.stringify({
      format: "mp4",
      mediaUrl: "https://1.1.1.1/watch?v=test",
      quality: "1080"
    }),
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie
    },
    method: "POST"
  });

  const jobId = createResponse.payload.jobId;
  await controller.started;

  await fs.mkdir(path.join(app.config.download.downloadDir, jobId), {
    recursive: true
  });
  await fs.writeFile(
    path.join(app.config.download.downloadDir, jobId, "clip.mp4"),
    "hello"
  );

  const allowedSnapshot = await requestJson(app.baseUrl, `/api/jobs/${jobId}`, {
    headers: {
      Cookie: cookie
    }
  });
  const allowedDownload = await fetch(
    `${app.baseUrl}/api/downloads/${jobId}/clip.mp4`,
    {
      headers: {
        Cookie: cookie
      }
    }
  );
  const allowedDownloadBody = await allowedDownload.text();
  const allowedStream = await openSse(app.baseUrl, `/api/jobs/${jobId}/events`, {
    Cookie: cookie
  });

  t.after(() => {
    allowedStream.request.destroy();
    allowedStream.response.destroy();
  });

  assert.equal(allowedSnapshot.response.status, 200);
  assert.equal(allowedDownload.status, 200);
  assert.equal(allowedDownloadBody, "hello");
  assert.equal(allowedStream.response.statusCode, 200);
});
