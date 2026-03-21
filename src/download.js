import { spawn } from "node:child_process";
import crypto from "node:crypto";
import dns from "node:dns/promises";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { AppError } from "./errors.js";

const videoFormats = ["mp4", "webm"];
const audioFormats = ["mp3", "m4a", "wav"];
const qualityOptions = [
  "best",
  "2160",
  "1440",
  "1080",
  "720",
  "480",
  "360",
  "240",
  "worst"
];
const controlCharacterPattern = /[\u0000-\u001f\u007f]/;

function expectBoolean(value, label) {
  if (typeof value !== "boolean") {
    throw new AppError(`${label} must be true or false.`, 400);
  }

  return value;
}

function expectChoice(value, label, choices) {
  if (typeof value !== "string" || !choices.includes(value)) {
    throw new AppError(`${label} is not allowed.`, 400);
  }

  return value;
}

function isPrivateIpv4(address) {
  const parts = address.split(".").map((value) => Number(value));

  if (parts.length !== 4 || parts.some((value) => !Number.isInteger(value))) {
    return true;
  }

  const [a, b] = parts;

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

function isPrivateIpv6(address) {
  const normalized = address.toLowerCase();

  if (normalized === "::" || normalized === "::1") {
    return true;
  }

  if (normalized.startsWith("::ffff:")) {
    return isPrivateAddress(normalized.slice(7));
  }

  return (
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb")
  );
}

function isPrivateAddress(address) {
  const version = net.isIP(address);

  if (version === 4) {
    return isPrivateIpv4(address);
  }

  if (version === 6) {
    return isPrivateIpv6(address);
  }

  return true;
}

async function validatePublicUrl(rawUrl, config) {
  if (typeof rawUrl !== "string") {
    throw new AppError("mediaUrl must be a string.", 400);
  }

  const trimmedUrl = rawUrl.trim();

  if (!trimmedUrl) {
    throw new AppError("Paste a URL first.", 400);
  }

  if (trimmedUrl.length > config.download.maxUrlLength) {
    throw new AppError("That URL is too long.", 400);
  }

  if (controlCharacterPattern.test(trimmedUrl) || /\s/.test(trimmedUrl)) {
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

  const hostname = parsedUrl.hostname.toLowerCase();

  if (!hostname || (!hostname.includes(".") && !net.isIP(hostname))) {
    throw new AppError("The hostname is not allowed.", 400);
  }

  if (
    hostname === "localhost" ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    throw new AppError("That hostname is not allowed.", 400);
  }

  if (net.isIP(hostname) && isPrivateAddress(hostname)) {
    throw new AppError("Private or loopback addresses are not allowed.", 400);
  }

  if (!net.isIP(hostname)) {
    try {
      const addresses = await dns.lookup(hostname, {
        all: true,
        verbatim: true
      });

      if (
        addresses.length > 0 &&
        addresses.every((entry) => isPrivateAddress(entry.address))
      ) {
        throw new AppError("Private or loopback addresses are not allowed.", 400);
      }
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      throw new AppError("Could not resolve that hostname.", 400);
    }
  }

  return parsedUrl.toString();
}

function buildVideoSelector(format, quality) {
  const audioExtension = format === "mp4" ? "m4a" : "webm";

  if (quality === "worst") {
    return "worstvideo*+worstaudio/worst";
  }

  if (quality === "best") {
    return [
      `bestvideo[ext=${format}]+bestaudio[ext=${audioExtension}]`,
      `best[ext=${format}]`,
      "best"
    ].join("/");
  }

  return [
    `bestvideo[height<=${quality}][ext=${format}]+bestaudio[ext=${audioExtension}]`,
    `best[height<=${quality}][ext=${format}]`,
    `best[height<=${quality}]`
  ].join("/");
}

function buildYtDlpArgs(url, settings, config, jobDir) {
  const args = [
    "--no-config-locations",
    "--no-warnings",
    "--no-progress",
    "--restrict-filenames",
    "--trim-filenames",
    "160",
    "--windows-filenames",
    "--output-na-placeholder",
    "unknown",
    "--paths",
    jobDir,
    "-o",
    "%(title).120B_[%(id)s].%(ext)s"
  ];

  if (settings.includePlaylist) {
    args.push(
      "--yes-playlist",
      "--playlist-end",
      String(config.download.maxPlaylistItems)
    );
  } else {
    args.push("--no-playlist");
  }

  if (settings.audioOnly) {
    args.push(
      "--format",
      "bestaudio/best",
      "--extract-audio",
      "--audio-format",
      settings.format
    );
  } else {
    args.push(
      "--format",
      buildVideoSelector(settings.format, settings.quality),
      "--merge-output-format",
      settings.format
    );
  }

  args.push("--", url);
  return args;
}

function truncateOutput(currentValue, chunk) {
  const combined = `${currentValue}${chunk.toString("utf8")}`;
  return combined.length > 8000 ? combined.slice(combined.length - 8000) : combined;
}

function normalizeYtDlpMessage(stderr, stdout) {
  const source = (stderr || stdout || "yt-dlp failed.").trim();
  const firstLine =
    source.split(/\r?\n/).find((line) => line.trim()) || "yt-dlp failed.";

  return firstLine.slice(0, 240);
}

function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn("yt-dlp", args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });

    child.stdout.on("data", (chunk) => {
      stdout = truncateOutput(stdout, chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr = truncateOutput(stderr, chunk);
    });

    child.on("error", (error) => {
      if (error && error.code === "ENOENT") {
        reject(
          new AppError("yt-dlp is not installed or is not available on PATH.", 503)
        );
        return;
      }

      reject(new AppError("The server could not start yt-dlp.", 500));
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new AppError(normalizeYtDlpMessage(stderr, stdout), 422));
    });
  });
}

async function collectFiles(jobDir) {
  const entries = await fs.readdir(jobDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    if (entry.name.endsWith(".part") || entry.name.endsWith(".ytdl")) {
      continue;
    }

    const absolutePath = path.join(jobDir, entry.name);
    const stats = await fs.stat(absolutePath);

    files.push({
      name: entry.name,
      size: stats.size
    });
  }

  files.sort((left, right) => left.name.localeCompare(right.name));
  return files;
}

export async function ensureDownloadDir(config) {
  await fs.mkdir(config.download.downloadDir, { recursive: true });
}

export async function cleanupDownloads(config) {
  await ensureDownloadDir(config);

  const entries = await fs.readdir(config.download.downloadDir, {
    withFileTypes: true
  });
  const cutoff = Date.now() - config.download.cleanupAfterHours * 60 * 60 * 1000;

  for (const entry of entries) {
    const absolutePath = path.join(config.download.downloadDir, entry.name);
    const stats = await fs.stat(absolutePath);

    if (stats.mtimeMs >= cutoff) {
      continue;
    }

    await fs.rm(absolutePath, {
      force: true,
      recursive: true
    });
  }
}

export function getClientOptions(config) {
  return {
    defaults: {
      audioOnly: config.download.defaultAudioOnly,
      format: config.download.defaultFormat,
      quality: config.download.defaultQuality,
      includePlaylist: config.download.defaultIncludePlaylist
    },
    formats: {
      audio: [...audioFormats],
      video: [...videoFormats]
    },
    qualities: [...qualityOptions]
  };
}

export async function validateDownloadRequest(payload, config) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new AppError("Request body must be a JSON object.", 400);
  }

  const mediaUrl = await validatePublicUrl(payload.mediaUrl, config);
  const audioOnly =
    payload.audioOnly === undefined
      ? config.download.defaultAudioOnly
      : expectBoolean(payload.audioOnly, "audioOnly");
  const includePlaylist =
    payload.includePlaylist === undefined
      ? config.download.defaultIncludePlaylist
      : expectBoolean(payload.includePlaylist, "includePlaylist");
  const quality =
    payload.quality === undefined
      ? config.download.defaultQuality
      : expectChoice(payload.quality, "quality", qualityOptions);
  const allowedFormats = audioOnly ? audioFormats : videoFormats;
  const format =
    payload.format === undefined
      ? config.download.defaultFormat
      : expectChoice(payload.format, "format", allowedFormats);

  if (audioOnly && videoFormats.includes(format)) {
    throw new AppError(
      "Choose an audio format when audio-only mode is enabled.",
      400
    );
  }

  if (!audioOnly && audioFormats.includes(format)) {
    throw new AppError("Choose a video format when downloading video.", 400);
  }

  return {
    mediaUrl,
    audioOnly,
    includePlaylist,
    format,
    quality
  };
}

export async function downloadMedia(settings, config) {
  await cleanupDownloads(config);

  const jobId = crypto.randomBytes(12).toString("hex");
  const jobDir = path.join(config.download.downloadDir, jobId);

  await fs.mkdir(jobDir, { recursive: true });
  await runYtDlp(buildYtDlpArgs(settings.mediaUrl, settings, config, jobDir));

  const files = await collectFiles(jobDir);

  if (files.length === 0) {
    throw new AppError(
      "yt-dlp finished, but no downloadable file was produced.",
      500
    );
  }

  return {
    jobId,
    files: files.map((file) => ({
      name: file.name,
      size: file.size,
      url: `/api/downloads/${jobId}/${encodeURIComponent(file.name)}`
    }))
  };
}

export async function resolveDownloadFile(jobId, encodedFileName, config) {
  if (!/^[a-f0-9]{24}$/.test(jobId)) {
    throw new AppError("That download does not exist.", 404);
  }

  let fileName;

  try {
    fileName = decodeURIComponent(encodedFileName);
  } catch {
    throw new AppError("That file name is invalid.", 400);
  }

  if (
    !fileName ||
    fileName !== path.basename(fileName) ||
    controlCharacterPattern.test(fileName)
  ) {
    throw new AppError("That file name is invalid.", 400);
  }

  const jobDir = path.join(config.download.downloadDir, jobId);
  const absolutePath = path.resolve(jobDir, fileName);

  if (!absolutePath.startsWith(jobDir + path.sep)) {
    throw new AppError("That file name is invalid.", 400);
  }

  let stats;

  try {
    stats = await fs.stat(absolutePath);
  } catch {
    throw new AppError("That file does not exist.", 404);
  }

  if (!stats.isFile()) {
    throw new AppError("That file does not exist.", 404);
  }

  return {
    absolutePath,
    fileName,
    size: stats.size
  };
}
