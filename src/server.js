import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import {
  buildLogoutCookie,
  buildSessionCookie,
  createSessionToken,
  getSessionToken,
  passwordMatches,
  verifySessionToken
} from "./auth.js";
import { loadConfig } from "./config.js";
import {
  cleanupDownloads,
  downloadMedia,
  ensureDownloadDir,
  getClientOptions,
  resolveDownloadFile,
  validateDownloadRequest
} from "./download.js";
import { AppError } from "./errors.js";

const config = loadConfig();
const staticMimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};
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
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'"
  ].join("; "),
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY"
};

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

const loginLimiter = createRateLimiter(
  config.rateLimit.loginWindowMinutes * 60 * 1000,
  config.rateLimit.loginMaxAttempts
);
const downloadLimiter = createRateLimiter(
  config.rateLimit.downloadWindowMinutes * 60 * 1000,
  config.rateLimit.downloadMaxRequests
);

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

function ensureAuthenticated(request) {
  if (!config.auth.requirePassword) {
    return;
  }

  const token = getSessionToken(request, config);

  if (!verifySessionToken(token, config)) {
    throw new AppError("Password required.", 401);
  }
}

function getAuthState(request) {
  if (!config.auth.requirePassword) {
    return true;
  }

  return verifySessionToken(getSessionToken(request, config), config);
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

  if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) {
    throw new AppError("Request body must be a JSON object.", 400);
  }

  return parsedBody;
}

async function serveStatic(requestPath, response, sendBody) {
  const relativePath =
    requestPath === "/" || !path.extname(requestPath)
      ? "./index.html"
      : `.${requestPath}`;
  const filePath = path.resolve(config.publicDir, relativePath);

  if (!filePath.startsWith(config.publicDir + path.sep)) {
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

  const extension = path.extname(filePath).toLowerCase();

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

async function serveDownload(jobId, encodedFileName, request, response, sendBody) {
  ensureAuthenticated(request);

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

  stream.pipe(response);
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
      token: session.token,
      expiresAt: session.expiresAt
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
  sendJson(response, 200, {
    authRequired: config.auth.requirePassword,
    authenticated: getAuthState(request),
    client: getClientOptions(config)
  });
}

async function handleDownloadRequest(request, response) {
  ensureAuthenticated(request);

  if (!downloadLimiter.allow(getClientIp(request))) {
    throw new AppError("Too many download requests. Try again later.", 429);
  }

  const body = await readJsonBody(request);
  const settings = await validateDownloadRequest(body, config);
  const result = await downloadMedia(settings, config);

  sendJson(response, 200, {
    ok: true,
    files: result.files,
    settings
  });
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

await ensureDownloadDir(config);
await cleanupDownloads(config);

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

server.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});

server.listen(config.server.port, config.server.host, () => {
  console.log(`Listening on http://${config.server.host}:${config.server.port}`);
});
