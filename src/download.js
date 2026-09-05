import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { AppError } from "./errors.js";
import { validatePublicHttpUrl } from "./network.js";
import { buildProgressArgs, parseProgressLine } from "./progress.js";

const videoFormats = ["mp4", "webm"];
const audioFormats = ["mp3", "m4a", "wav"];
const convertVideoOptions = ["none", "remux", "h264"];
const downloadResultPrefix = "__YTDLP_RESULT__";
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

function buildVideoSelector(format, quality) {
  const audioExtension = format === "mp4" ? "m4a" : "webm";
  let videoSelector;

  if (quality === "worst") {
    videoSelector = [
      `worstvideo[ext=${format}]`,
      "worstvideo",
      "worst"
    ].join("/");
  } else if (quality === "best") {
    videoSelector = [
      `bestvideo[ext=${format}]`,
      "bestvideo",
      `best[ext=${format}]`,
      "best"
    ].join("/");
  } else {
    videoSelector = [
      `bestvideo[height<=${quality}][ext=${format}]`,
      `bestvideo[height<=${quality}]`,
      `best[height<=${quality}][ext=${format}]`,
      `best[height<=${quality}]`
    ].join("/");
  }

  const audioSelector = [
    `${quality === "worst" ? "worstaudio" : "bestaudio"}[ext=${audioExtension}]`,
    quality === "worst" ? "worstaudio" : "bestaudio",
    quality === "worst" ? "worst" : "best"
  ].join("/");

  // A comma asks yt-dlp for separate files. A plus asks it to merge with
  // ffmpeg, which this project intentionally does not install.
  return `${videoSelector},${audioSelector}`;
}

export function buildYtDlpArgs(url, settings, config, jobDir, proxyUrl) {
  const args = [
    "--no-config-locations",
    "--no-warnings",
    "--restrict-filenames",
    "--trim-filenames",
    "160",
    "--windows-filenames",
    "--output-na-placeholder",
    "unknown",
    "--paths",
    jobDir,
    "-o",
    "%(title).100B_[%(id)s]__%(format_id)s.%(ext)s",
    "--print",
    `after_move:${downloadResultPrefix}%()j`,
    ...buildProgressArgs()
  ];

  if (proxyUrl) {
    args.push("--proxy", proxyUrl);
  }

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
    args.push("--format", "bestaudio/best");
  } else {
    const browserOutputFormat =
      settings.convertVideo === "none" ? settings.format : "mp4";
    args.push(
      "--format",
      buildVideoSelector(browserOutputFormat, settings.quality)
    );
  }

  args.push("--", url);
  return args;
}

function buildStreamLinkArgs(url, settings, config, proxyUrl) {
  const args = [
    "--no-config-locations",
    "--no-warnings",
    "-g"
  ];

  if (proxyUrl) {
    args.push("--proxy", proxyUrl);
  }

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
    args.push("--format", "bestaudio/best");
  } else {
    const browserOutputFormat =
      settings.convertVideo === "none" ? settings.format : "mp4";
    args.push(
      "--format",
      buildVideoSelector(browserOutputFormat, settings.quality)
    );
  }

  args.push("--", url);
  return args;
}

function truncateOutput(currentValue, chunk) {
  const combined = `${currentValue}${chunk.toString("utf8")}`;
  return combined.length > 8000 ? combined.slice(combined.length - 8000) : combined;
}

function normalizeCommandMessage(stderr, stdout, fallback) {
  const source = (stderr || stdout || fallback).trim();
  const firstLine =
    source.split(/\r?\n/).find((line) => line.trim()) || fallback;

  return firstLine.slice(0, 240);
}

function normalizeYtDlpMessage(stderr, stdout) {
  return normalizeCommandMessage(stderr, stdout, "yt-dlp failed.");
}

function emitProgress(onProgress, progress) {
  if (typeof onProgress !== "function" || !progress) {
    return;
  }

  onProgress(progress);
}

function attachProgressReader(stream, onProgress, onLine) {
  const reader = readline.createInterface({
    crlfDelay: Infinity,
    input: stream
  });

  reader.on("line", (line) => {
    if (onLine?.(line)) {
      return;
    }

    emitProgress(onProgress, parseProgressLine(line));
  });

  return reader;
}

function runYtDlp(args, onProgress) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const downloadMetadata = [];
    const child = spawn("yt-dlp", args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const readers = [
      attachProgressReader(child.stdout, onProgress, (line) => {
        if (!line.startsWith(downloadResultPrefix)) {
          return false;
        }

        try {
          downloadMetadata.push(
            JSON.parse(line.slice(downloadResultPrefix.length))
          );
        } catch {
          // A malformed metadata line is handled after the command completes.
        }

        return true;
      }),
      attachProgressReader(child.stderr, onProgress)
    ];

    child.stdout.on("data", (chunk) => {
      stdout = truncateOutput(stdout, chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr = truncateOutput(stderr, chunk);
    });

    child.on("error", (error) => {
      readers.forEach((reader) => {
        reader.close();
      });

      if (error && error.code === "ENOENT") {
        reject(
          new AppError("yt-dlp is not installed or is not available on PATH.", 503)
        );
        return;
      }

      reject(new AppError("The server could not start yt-dlp.", 500));
    });

    child.on("close", (code) => {
      readers.forEach((reader) => {
        reader.close();
      });

      if (code === 0) {
        resolve(downloadMetadata);
        return;
      }

      reject(new AppError(normalizeYtDlpMessage(stderr, stdout), 422));
    });
  });
}

function runYtDlpForLinks(args) {
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
      if (code !== 0) {
        reject(new AppError(normalizeYtDlpMessage(stderr, stdout), 422));
        return;
      }

      const urls = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

      if (urls.length === 0) {
        reject(new AppError("yt-dlp did not return a stream URL.", 422));
        return;
      }

      resolve(urls);
    });
  });
}

function getStreamLinkName(index, totalLinks, settings) {
  if (settings.audioOnly) {
    return totalLinks === 1 ? "audio stream" : `audio stream ${index + 1}`;
  }

  if (totalLinks === 1) {
    return "stream";
  }

  if (totalLinks === 2) {
    return index === 0 ? "video stream" : "audio stream";
  }

  return `stream ${index + 1}`;
}

async function collectFiles(jobDir) {
  const entries = await fs.readdir(jobDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    if (
      entry.name.endsWith(".info.json") ||
      entry.name.endsWith(".part") ||
      entry.name.endsWith(".ytdl")
    ) {
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

function findFormatMetadata(result, formatId) {
  const requestedFormats = Array.isArray(result?.requested_formats)
    ? result.requested_formats
    : [];
  const requestedDownloads = Array.isArray(result?.requested_downloads)
    ? result.requested_downloads
    : [];

  return [...requestedDownloads, ...requestedFormats].find(
    (candidate) => String(candidate?.format_id || "") === String(formatId)
  );
}

function getFileMetadata(fileName, downloadMetadata) {
  const suffixMatch = fileName.match(/_\[([^\]]+)\]__([^/]+)\.[^.]+$/);
  const mediaIdFromName = suffixMatch?.[1] || "";
  const formatIdFromName = suffixMatch?.[2] || "";

  for (const result of downloadMetadata) {
    const candidates = [
      ...(Array.isArray(result?.requested_downloads)
        ? result.requested_downloads
        : []),
      ...(Array.isArray(result?.requested_formats)
        ? result.requested_formats
        : []),
      result
    ];

    let candidate = candidates.find((entry) => {
      const candidatePath =
        entry?.filepath || entry?._filename || entry?.filename || "";
      return candidatePath && path.basename(candidatePath) === fileName;
    });

    if (!candidate && mediaIdFromName === String(result?.id || "")) {
      candidate = findFormatMetadata(result, formatIdFromName);
    }

    if (!candidate) {
      continue;
    }

    const videoCodec = String(candidate.vcodec || "none");
    const audioCodec = String(candidate.acodec || "none");

    return {
      audioCodec,
      formatId: String(candidate.format_id || formatIdFromName || "unknown"),
      hasAudio: audioCodec !== "none",
      hasVideo: videoCodec !== "none",
      mediaId: String(result.id || mediaIdFromName),
      sourceFormat: path.extname(fileName).slice(1).toLowerCase(),
      title: String(result.title || result.fulltitle || mediaIdFromName),
      videoCodec
    };
  }

  return null;
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
      includePlaylist: config.download.defaultIncludePlaylist,
      convertVideo: config.download.defaultConvertVideo
    },
    formats: {
      audio: [...audioFormats],
      video: [...videoFormats]
    },
    convertVideoOptions: [...convertVideoOptions],
    qualities: [...qualityOptions]
  };
}

export async function validateDownloadRequest(payload, config) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new AppError("Request body must be a JSON object.", 400);
  }

  const mediaUrl = await validatePublicHttpUrl(
    payload.mediaUrl,
    config.download.maxUrlLength
  );
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
  const requestedConvertVideo =
    payload.convertVideo === undefined
      ? config.download.defaultConvertVideo
      : expectChoice(payload.convertVideo, "convertVideo", convertVideoOptions);
  const allowedFormats = audioOnly ? audioFormats : videoFormats;
  const format =
    payload.format === undefined
      ? config.download.defaultFormat
      : expectChoice(payload.format, "format", allowedFormats);
  const convertVideo = !audioOnly ? requestedConvertVideo : "none";

  if (audioOnly && videoFormats.includes(format)) {
    throw new AppError(
      "Choose an audio format when audio-only mode is enabled.",
      400
    );
  }

  if (!audioOnly && audioFormats.includes(format)) {
    throw new AppError("Choose a video format when downloading video.", 400);
  }

  if (audioOnly && requestedConvertVideo !== "none") {
    throw new AppError("Conversion is only available for video downloads.", 400);
  }

  return {
    mediaUrl,
    audioOnly,
    includePlaylist,
    format,
    quality,
    convertVideo
  };
}

export async function executeDownloadJob({
  config,
  jobId = crypto.randomBytes(12).toString("hex"),
  onProgress,
  proxyUrl,
  settings
}) {
  await cleanupDownloads(config);

  const jobDir = path.join(config.download.downloadDir, jobId);

  await fs.mkdir(jobDir, { recursive: true });

  emitProgress(onProgress, {
    downloadedBytes: null,
    etaSeconds: null,
    message: "Starting download...",
    percent: null,
    phase: "downloading",
    totalBytes: null
  });

  const downloadMetadata = await runYtDlp(
    buildYtDlpArgs(settings.mediaUrl, settings, config, jobDir, proxyUrl),
    onProgress
  );

  const files = await collectFiles(jobDir);

  if (files.length === 0) {
    throw new AppError(
      "yt-dlp finished, but no downloadable file was produced.",
      500
    );
  }

  const describedFiles = files.map((file) => ({
    ...file,
    metadata: getFileMetadata(file.name, downloadMetadata)
  }));
  const unidentifiedFile = describedFiles.find((file) => !file.metadata);

  if (unidentifiedFile) {
    throw new AppError(
      `yt-dlp finished, but track metadata was missing for ${unidentifiedFile.name}.`,
      500
    );
  }

  emitProgress(onProgress, {
    downloadedBytes: null,
    etaSeconds: null,
    message: "Ready for browser processing.",
    percent: 100,
    phase: "postprocessing",
    totalBytes: null
  });

  return {
    files: describedFiles.map((file) => ({
      ...file.metadata,
      name: file.name,
      size: file.size,
      url: `/api/downloads/${jobId}/${encodeURIComponent(file.name)}`
    })),
    jobId
  };
}

export async function executeStreamLinkLookup({
  config,
  proxyUrl,
  settings
}) {
  const urls = await runYtDlpForLinks(
    buildStreamLinkArgs(settings.mediaUrl, settings, config, proxyUrl)
  );

  return {
    links: urls.map((url, index) => ({
      name: getStreamLinkName(index, urls.length, settings),
      url
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
    /[\u0000-\u001f\u007f]/.test(fileName)
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
