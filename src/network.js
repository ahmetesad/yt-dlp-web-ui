import dns from "node:dns/promises";
import net from "node:net";
import { AppError } from "./errors.js";

function isBlockedIpv4(address) {
  const parts = address.split(".").map((value) => Number(value));

  if (
    parts.length !== 4 ||
    parts.some(
      (value) => !Number.isInteger(value) || value < 0 || value > 255
    )
  ) {
    return true;
  }

  const [a, b, c] = parts;

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

function isBlockedIpv6(address) {
  const normalized = address.toLowerCase();

  if (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb") ||
    normalized.startsWith("2001:db8:") ||
    normalized.startsWith("ff")
  ) {
    return true;
  }

  if (normalized.startsWith("::ffff:")) {
    return isBlockedAddress(normalized.slice(7));
  }

  return false;
}

export function isBlockedAddress(address) {
  const version = net.isIP(address);

  if (version === 4) {
    return isBlockedIpv4(address);
  }

  if (version === 6) {
    return isBlockedIpv6(address);
  }

  return true;
}

function assertAllowedHostname(hostname) {
  if (
    typeof hostname !== "string" ||
    !hostname ||
    (!hostname.includes(".") && !net.isIP(hostname))
  ) {
    throw new AppError("The hostname is not allowed.", 400);
  }

  const normalized = hostname.toLowerCase();

  if (
    normalized === "localhost" ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal")
  ) {
    throw new AppError("That hostname is not allowed.", 400);
  }

  return normalized;
}

export function normalizeTargetPort(rawPort, protocol) {
  const fallbackPort = protocol === "https:" ? 443 : 80;
  const parsedPort = rawPort ? Number(rawPort) : fallbackPort;

  if (
    !Number.isInteger(parsedPort) ||
    parsedPort < 1 ||
    parsedPort > 65535
  ) {
    throw new AppError("That port is not allowed.", 400);
  }

  return parsedPort;
}

export async function resolvePublicOrigin(hostname, rawPort, protocol) {
  const normalizedHostname = assertAllowedHostname(hostname);
  const port = normalizeTargetPort(rawPort, protocol);

  if (net.isIP(normalizedHostname)) {
    if (isBlockedAddress(normalizedHostname)) {
      throw new AppError("Private or loopback addresses are not allowed.", 400);
    }

    return {
      address: normalizedHostname,
      hostname: normalizedHostname,
      port
    };
  }

  let addresses;

  try {
    addresses = await dns.lookup(normalizedHostname, {
      all: true,
      verbatim: true
    });
  } catch {
    throw new AppError("Could not resolve that hostname.", 400);
  }

  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new AppError("Could not resolve that hostname.", 400);
  }

  if (addresses.some((entry) => isBlockedAddress(entry.address))) {
    throw new AppError("Private or loopback addresses are not allowed.", 400);
  }

  return {
    address: addresses[0].address,
    hostname: normalizedHostname,
    port
  };
}

export async function validatePublicHttpUrl(rawUrl, maxUrlLength) {
  if (typeof rawUrl !== "string") {
    throw new AppError("mediaUrl must be a string.", 400);
  }

  const trimmedUrl = rawUrl.trim();

  if (!trimmedUrl) {
    throw new AppError("Paste a URL first.", 400);
  }

  if (trimmedUrl.length > maxUrlLength) {
    throw new AppError("That URL is too long.", 400);
  }

  if (/[\u0000-\u001f\u007f]/.test(trimmedUrl) || /\s/.test(trimmedUrl)) {
    throw new AppError("The URL contains invalid characters.", 400);
  }

  let parsedUrl;

  try {
    parsedUrl = new URL(trimmedUrl);
  } catch {
    throw new AppError("That is not a valid URL.", 400);
  }

  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw new AppError("Only http and https URLs are allowed.", 400);
  }

  if (parsedUrl.username || parsedUrl.password) {
    throw new AppError("Embedded URL credentials are not allowed.", 400);
  }

  await resolvePublicOrigin(
    parsedUrl.hostname,
    parsedUrl.port,
    parsedUrl.protocol
  );

  return parsedUrl.toString();
}
