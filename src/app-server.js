import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildLogoutCookie,
  buildSessionCookie,
  createSessionToken,
  getValidatedCookieSessionToken,
  getValidatedSessionToken,
  passwordMatches
} from "./auth.js";
import {
  executeDownloadJob,
  executeStreamLinkLookup,
  getClientOptions,
  resolveDownloadFile,
  validateDownloadRequest
} from "./download.js";
import { AppError } from "./errors.js";
import { createJobStore } from "./jobs.js";

const staticMimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm"
};
const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const browserDependencyFiles = new Map([
  [
    "/vendor/mediabunny.js",
    path.resolve(
      sourceDirectory,
      "../node_modules/mediabunny/dist/bundles/mediabunny.min.cjs"
    )
  ],
  [
    "/vendor/mediabunny-mp3-encoder.js",
    path.resolve(
      sourceDirectory,
      "../node_modules/@mediabunny/mp3-encoder/dist/bundles/mediabunny-mp3-encoder.min.js"
    )
  ]
]);
const downloadMimeTypes = {
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".wav": "audio/wav",
  ".webm": "video/webm"
};
const securityHeaders = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "base-uri 'none'",
    "connect-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "object-src 'none'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "worker-src 'self' blob:"
  ].join("; "),
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY"
};
const jobIdPattern = /^[a-f0-9]{24}$/;

function createRateLimiter(windowMs, limit) {
  if (limit <= 0 || windowMs <= 0) {
    return {
      allow() {
        return true;
      }
    };
  }

  const hits = new Map();

  return {
    allow(key) {
      const now = Date.now();
      const recentHits = (hits.get(key) || []).filter(
        (timestamp) => now - timestamp < windowMs
      );

      if (recentHits.length >= limit) {
        hits.set(key, recentHits);
        return false;
      }

      recentHits.push(now);
      hits.set(key, recentHits);
      return true;
    }
  };
}

function getClientIp(request) {
  return request.socket.remoteAddress || "unknown";
}

function createHeaders(extraHeaders = {}) {
  return {
    ...securityHeaders,
    "Cache-Control": "no-store",
    ...extraHeaders
  };
}

function sendJson(response, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);

  response.writeHead(
    statusCode,
    createHeaders({
      "Content-Length": Buffer.byteLength(body),
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders
    })
  );
  response.end(body);
}

function sanitizeFileNameForHeader(fileName) {
  return fileName.replace(/[^\x20-\x7e]+/g, "_").replace(/["\\]/g, "_");
}

function encodeFileNameForHeader(fileName) {
  return encodeURIComponent(fileName).replace(/['()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function writeSse(response, eventName, payload) {
  response.write(`event: ${eventName}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function requireJobId(jobId) {
  if (!jobIdPattern.test(jobId)) {
    throw new AppError("That job does not exist.", 404);
  }

  return jobId;
}

export function createAppServer({
  config,
  downloadExecutor = executeDownloadJob,
  deleteAfterDownloadMs = config.download.deleteAfterDownloadMinutes * 60 * 1000,
  streamResolver = executeStreamLinkLookup,
  jobTtlMs = 60 * 60 * 1000,
  proxyUrl = ""
}) {
  const jobStore = createJobStore({ jobTtlMs });
  const deleteTimers = new Map();
  const loginLimiter = createRateLimiter(
    config.rateLimit.loginWindowMinutes * 60 * 1000,
    config.rateLimit.loginMaxAttempts
  );
  const downloadLimiter = createRateLimiter(
    config.rateLimit.downloadWindowMinutes * 60 * 1000,
    config.rateLimit.downloadMaxRequests
  );

  function clearDeleteTimer(filePath) {
    const timer = deleteTimers.get(filePath);

    if (!timer) {
      return;
    }

    clearTimeout(timer);
    deleteTimers.delete(filePath);
  }

  async function deleteFileAndMaybeJobDir(filePath) {
    clearDeleteTimer(filePath);

    try {
      await fsp.rm(filePath, { force: true });
    } catch {
      return;
    }

    const jobDir = path.dirname(filePath);

    try {
      const remainingEntries = await fsp.readdir(jobDir);

      if (remainingEntries.length === 0) {
        await fsp.rmdir(jobDir);
      }
    } catch {
      return;
    }
  }

  function scheduleDeleteAfterDownload(filePath) {
    if (!config.download.deleteAfterDownload || deleteAfterDownloadMs <= 0) {
      return;
    }

    clearDeleteTimer(filePath);
    const timer = setTimeout(() => {
      deleteFileAndMaybeJobDir(filePath).catch(() => {
        return;
      });
    }, deleteAfterDownloadMs);

    if (typeof timer.unref === "function") {
      timer.unref();
    }

    deleteTimers.set(filePath, timer);
  }

  function ensureAuthenticated(request, { cookieOnly = false } = {}) {
    if (!config.auth.requirePassword) {
      return;
    }

    const token = cookieOnly
      ? getValidatedCookieSessionToken(request, config)
      : getValidatedSessionToken(request, config);

    if (!token) {
      throw new AppError("Password required.", 401);
    }
  }

  function getAuthState(request) {
    if (!config.auth.requirePassword) {
      return true;
    }

    return Boolean(getValidatedSessionToken(request, config));
  }

  async function readJsonBody(request) {
    const contentType = request.headers["content-type"] || "";

    if (!contentType.startsWith("application/json")) {
      throw new AppError("Requests must use application/json.", 415);
    }

    const chunks = [];
    let totalLength = 0;

    for await (const chunk of request) {
      totalLength += chunk.length;

      if (totalLength > config.server.maxRequestBytes) {
        throw new AppError("Request body is too large.", 413);
      }

      chunks.push(chunk);
    }

    if (chunks.length === 0) {
      return {};
    }

    let parsedBody;

    try {
      parsedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new AppError("Request body is not valid JSON.", 400);
    }

    if (
      !parsedBody ||
      typeof parsedBody !== "object" ||
      Array.isArray(parsedBody)
    ) {
      throw new AppError("Request body must be a JSON object.", 400);
    }

    return parsedBody;
  }

  async function serveStatic(requestPath, response, sendBody) {
    const browserDependencyPath = browserDependencyFiles.get(requestPath);
    const relativePath =
      requestPath === "/" || !path.extname(requestPath)
        ? "./index.html"
        : `.${requestPath}`;
    const filePath =
      browserDependencyPath || path.resolve(config.publicDir, relativePath);

    if (
      !browserDependencyPath &&
      !filePath.startsWith(config.publicDir + path.sep)
    ) {
      throw new AppError("Not found.", 404);
    }

    let body;

    try {
      body = await fsp.readFile(filePath);
    } catch (error) {
      if (error && error.code === "ENOENT") {
        throw new AppError("Not found.", 404);
      }

      throw error;
    }

    const extension = path
      .extname(browserDependencyPath ? requestPath : filePath)
      .toLowerCase();

    response.writeHead(
      200,
      createHeaders({
        "Content-Length": body.length,
        "Content-Type":
          staticMimeTypes[extension] || "application/octet-stream"
      })
    );
    response.end(sendBody ? body : undefined);
  }

  async function serveDownload(
    jobId,
    encodedFileName,
    request,
    response,
    sendBody
  ) {
    ensureAuthenticated(request, { cookieOnly: true });

    const file = await resolveDownloadFile(jobId, encodedFileName, config);
    const extension = path.extname(file.fileName).toLowerCase();
    const safeFallbackName = sanitizeFileNameForHeader(file.fileName);
    const contentDisposition = [
      `attachment; filename="${safeFallbackName}"`,
      `filename*=UTF-8''${encodeFileNameForHeader(file.fileName)}`
    ].join("; ");

    response.writeHead(
      200,
      createHeaders({
        "Content-Disposition": contentDisposition,
        "Content-Length": file.size,
        "Content-Type":
          downloadMimeTypes[extension] || "application/octet-stream"
      })
    );

    if (!sendBody) {
      response.end();
      return;
    }

    const stream = fs.createReadStream(file.absolutePath);

    stream.on("error", () => {
      response.destroy();
    });

    response.once("finish", () => {
      if (response.statusCode === 200) {
        scheduleDeleteAfterDownload(file.absolutePath);
      }
    });

    stream.pipe(response);
  }

  async function runJob(jobId, settings) {
    try {
      const result = await downloadExecutor({
        config,
        jobId,
        onProgress(progress) {
          jobStore.updateProgress(jobId, progress);
        },
        proxyUrl,
        settings
      });

      jobStore.completeJob(jobId, result.files);
    } catch (error) {
      if (error instanceof AppError) {
        jobStore.failJob(jobId, error.message);
        return;
      }

      console.error(error);
      jobStore.failJob(jobId, "Internal server error.");
    }
  }

  async function handleLogin(request, response) {
    if (!config.auth.requirePassword) {
      throw new AppError("Password auth is disabled.", 400);
    }

    if (!loginLimiter.allow(getClientIp(request))) {
      throw new AppError("Too many login attempts. Try again later.", 429);
    }

    const body = await readJsonBody(request);
    const password = typeof body.password === "string" ? body.password : "";

    if (!passwordMatches(password, config.auth.password)) {
      throw new AppError("Incorrect password.", 401);
    }

    const session = createSessionToken(config);

    sendJson(
      response,
      200,
      {
        authenticated: true,
        expiresAt: session.expiresAt,
        token: session.token
      },
      {
        "Set-Cookie": buildSessionCookie(
          session.token,
          config.auth.sessionDays * 24 * 60 * 60,
          config
        )
      }
    );
  }

  function handleLogout(response) {
    sendJson(
      response,
      200,
      { authenticated: false },
      { "Set-Cookie": buildLogoutCookie(config) }
    );
  }

  function handleBootstrap(request, response) {
    const token = getValidatedSessionToken(request, config);
    const extraHeaders =
      config.auth.requirePassword && token
        ? {
            "Set-Cookie": buildSessionCookie(
              token,
              config.auth.sessionDays * 24 * 60 * 60,
              config
            )
          }
        : {};

    sendJson(
      response,
      200,
      {
        authRequired: config.auth.requirePassword,
        authenticated: getAuthState(request),
        client: getClientOptions(config)
      },
      extraHeaders
    );
  }

  async function handleDownloadRequest(request, response) {
    ensureAuthenticated(request);

    if (!downloadLimiter.allow(getClientIp(request))) {
      throw new AppError("Too many download requests. Try again later.", 429);
    }

    jobStore.cleanupExpired();

    const body = await readJsonBody(request);
    const settings = await validateDownloadRequest(body, config);
    const job = jobStore.createJob(settings);

    setImmediate(() => {
      runJob(job.jobId, settings);
    });

    sendJson(response, 202, {
      jobId: job.jobId,
      status: job.status
    });
  }

  async function handleStreamLinkRequest(request, response) {
    ensureAuthenticated(request);

    if (!downloadLimiter.allow(getClientIp(request))) {
      throw new AppError("Too many download requests. Try again later.", 429);
    }

    const body = await readJsonBody(request);
    const settings = await validateDownloadRequest(body, config);
    const payload = await streamResolver({
      config,
      proxyUrl,
      settings
    });

    sendJson(response, 200, payload);
  }

  function handleJobSnapshot(request, response, jobId) {
    ensureAuthenticated(request, { cookieOnly: true });

    const snapshot = jobStore.getSnapshot(requireJobId(jobId));

    if (!snapshot) {
      throw new AppError("That job does not exist.", 404);
    }

    sendJson(response, 200, snapshot);
  }

  function handleJobEvents(request, response, jobId) {
    ensureAuthenticated(request, { cookieOnly: true });
    requireJobId(jobId);

    let snapshot = jobStore.getSnapshot(jobId);

    if (!snapshot) {
      throw new AppError("That job does not exist.", 404);
    }

    response.writeHead(
      200,
      createHeaders({
        Connection: "keep-alive",
        "Content-Type": "text/event-stream; charset=utf-8"
      })
    );
    response.write("retry: 2000\n\n");

    let snapshotSent = false;
    const pendingEvents = [];
    const unsubscribe = jobStore.subscribe(jobId, (eventName, payload) => {
      if (!snapshotSent) {
        pendingEvents.push([eventName, payload]);
        return;
      }

      writeSse(response, eventName, payload);
    });

    if (!unsubscribe) {
      response.end();
      return;
    }

    const heartbeat = setInterval(() => {
      response.write(": keep-alive\n\n");
    }, 15000);

    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };

    request.on("close", cleanup);
    response.on("close", cleanup);

    snapshot = jobStore.getSnapshot(jobId) || snapshot;
    writeSse(response, "snapshot", snapshot);
    snapshotSent = true;

    for (const [eventName, payload] of pendingEvents) {
      writeSse(response, eventName, payload);
    }

    if (snapshot.status === "completed") {
      writeSse(response, "complete", {
        files: snapshot.files,
        status: snapshot.status
      });
      cleanup();
      response.end();
      return;
    }

    if (snapshot.status === "failed") {
      writeSse(response, "error", {
        error: snapshot.error,
        status: snapshot.status
      });
      cleanup();
      response.end();
    }
  }

  async function handleRequest(request, response) {
    const url = new URL(
      request.url || "/",
      `http://${request.headers.host || "localhost"}`
    );
    const sendBody = request.method !== "HEAD";

    if (request.method === "GET" && url.pathname === "/api/bootstrap") {
      handleBootstrap(request, response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/auth/login") {
      await handleLogin(request, response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/auth/logout") {
      handleLogout(response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/download") {
      await handleDownloadRequest(request, response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/stream-link") {
      await handleStreamLinkRequest(request, response);
      return;
    }

    const jobEventsMatch = url.pathname.match(/^\/api\/jobs\/([a-f0-9]{24})\/events$/);

    if (request.method === "GET" && jobEventsMatch) {
      handleJobEvents(request, response, jobEventsMatch[1]);
      return;
    }

    const jobSnapshotMatch = url.pathname.match(/^\/api\/jobs\/([a-f0-9]{24})$/);

    if (request.method === "GET" && jobSnapshotMatch) {
      handleJobSnapshot(request, response, jobSnapshotMatch[1]);
      return;
    }

    const downloadMatch = url.pathname.match(
      /^\/api\/downloads\/([a-f0-9]{24})\/(.+)$/
    );

    if ((request.method === "GET" || request.method === "HEAD") && downloadMatch) {
      await serveDownload(
        downloadMatch[1],
        downloadMatch[2],
        request,
        response,
        sendBody
      );
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      throw new AppError("Not found.", 404);
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      throw new AppError("Method not allowed.", 405);
    }

    await serveStatic(url.pathname, response, sendBody);
  }

  const server = http.createServer((request, response) => {
    handleRequest(request, response).catch((error) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }

      if (error instanceof AppError) {
        sendJson(response, error.statusCode, { error: error.message });
        return;
      }

      console.error(error);
      sendJson(response, 500, { error: "Internal server error." });
    });
  });

  return {
    close() {
      return new Promise((resolve, reject) => {
        for (const timer of deleteTimers.values()) {
          clearTimeout(timer);
        }

        deleteTimers.clear();
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    },
    jobStore,
    server
  };
}
