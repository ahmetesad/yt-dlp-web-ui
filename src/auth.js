import crypto from "node:crypto";

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function signPayload(payload, sessionSecret) {
  return crypto
    .createHmac("sha256", sessionSecret)
    .update(payload)
    .digest("hex");
}

export function passwordMatches(inputPassword, expectedPassword) {
  if (
    typeof inputPassword !== "string" ||
    typeof expectedPassword !== "string" ||
    !inputPassword ||
    !expectedPassword
  ) {
    return false;
  }

  return safeEqual(inputPassword, expectedPassword);
}

export function createSessionToken(config) {
  const expiresAt = Date.now() + config.auth.sessionDays * 24 * 60 * 60 * 1000;
  const nonce = crypto.randomBytes(16).toString("hex");
  const payload = `${expiresAt}.${nonce}`;
  const signature = signPayload(payload, config.auth.sessionSecret);

  return {
    token: `${payload}.${signature}`,
    expiresAt
  };
}

export function verifySessionToken(token, config) {
  if (typeof token !== "string") {
    return false;
  }

  const match = token.match(/^(\d{13})\.([a-f0-9]{32})\.([a-f0-9]{64})$/);

  if (!match) {
    return false;
  }

  const [, expiresAtRaw, nonce, providedSignature] = match;
  const expiresAt = Number(expiresAtRaw);

  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    return false;
  }

  const payload = `${expiresAt}.${nonce}`;
  const expectedSignature = signPayload(payload, config.auth.sessionSecret);

  return safeEqual(providedSignature, expectedSignature);
}

export function parseCookies(cookieHeader) {
  if (typeof cookieHeader !== "string" || !cookieHeader.trim()) {
    return {};
  }

  const cookies = {};

  for (const entry of cookieHeader.split(";")) {
    const separatorIndex = entry.indexOf("=");

    if (separatorIndex === -1) {
      continue;
    }

    const key = entry.slice(0, separatorIndex).trim();
    const value = entry.slice(separatorIndex + 1).trim();

    if (!key) {
      continue;
    }

    cookies[key] = value;
  }

  return cookies;
}

export function getSessionToken(request, config) {
  const headerToken = request.headers["x-session-token"];

  if (
    typeof headerToken === "string" &&
    headerToken.length > 0 &&
    headerToken.length < 256
  ) {
    return headerToken;
  }

  const cookies = parseCookies(request.headers.cookie);
  const cookieToken = cookies[config.auth.cookieName];

  if (
    typeof cookieToken === "string" &&
    cookieToken.length > 0 &&
    cookieToken.length < 256
  ) {
    return cookieToken;
  }

  return "";
}

export function buildSessionCookie(token, maxAgeSeconds, config) {
  const parts = [
    `${config.auth.cookieName}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAgeSeconds}`
  ];

  if (config.auth.secureCookies) {
    parts.push("Secure");
  }

  return parts.join("; ");
}

export function buildLogoutCookie(config) {
  const parts = [
    `${config.auth.cookieName}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0"
  ];

  if (config.auth.secureCookies) {
    parts.push("Secure");
  }

  return parts.join("; ");
}
