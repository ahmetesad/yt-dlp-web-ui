const PROGRESS_MARKER = "__YTDLP_PROGRESS__";
const FIELD_SEPARATOR = "\t";

function parseNumber(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();

  if (!trimmed || trimmed === "NA" || trimmed === "none") {
    return null;
  }

  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function parsePercent(value) {
  if (typeof value !== "string") {
    return null;
  }

  const cleaned = value.replace(/[^0-9.]/g, "");

  if (!cleaned) {
    return null;
  }

  const parsed = Number.parseFloat(cleaned);

  if (!Number.isFinite(parsed)) {
    return null;
  }

  return Math.max(0, Math.min(100, parsed));
}

function createProgressSnapshot({
  phase,
  percent,
  downloadedBytes,
  totalBytes,
  etaSeconds,
  message
}) {
  return {
    downloadedBytes: downloadedBytes ?? null,
    etaSeconds: etaSeconds ?? null,
    message,
    percent: percent ?? null,
    phase,
    totalBytes: totalBytes ?? null
  };
}

function parseDownloadProgress(parts) {
  if (parts.length < 8) {
    return null;
  }

  const status = parts[2];
  const downloadedBytes = parseNumber(parts[3]);
  const totalBytes = parseNumber(parts[4]) ?? parseNumber(parts[5]);
  const etaSeconds = parseNumber(parts[6]);
  let percent = parsePercent(parts[7]);

  if (status === "finished" && percent === null) {
    percent = 100;
  }

  return createProgressSnapshot({
    phase: "downloading",
    percent,
    downloadedBytes,
    totalBytes,
    etaSeconds,
    message:
      status === "finished"
        ? "Download finished. Finalizing media..."
        : "Downloading media..."
  });
}

function parsePostprocessProgress(parts) {
  if (parts.length < 6) {
    return null;
  }

  const postprocessor = parts[3];
  const etaSeconds = parseNumber(parts[4]);
  const percent = parsePercent(parts[5]);
  const message =
    postprocessor && postprocessor !== "NA"
      ? `Processing media with ${postprocessor}...`
      : "Processing media...";

  return createProgressSnapshot({
    phase: "postprocessing",
    percent,
    downloadedBytes: null,
    totalBytes: null,
    etaSeconds,
    message
  });
}

export function buildProgressArgs() {
  const downloadTemplate = [
    PROGRESS_MARKER,
    "download",
    "%(progress.status)s",
    "%(progress.downloaded_bytes)s",
    "%(progress.total_bytes)s",
    "%(progress.total_bytes_estimate)s",
    "%(progress.eta)s",
    "%(progress._percent_str)s"
  ].join(FIELD_SEPARATOR);
  const postprocessTemplate = [
    PROGRESS_MARKER,
    "postprocess",
    "%(progress.status)s",
    "%(progress.postprocessor)s",
    "%(progress.eta)s",
    "%(progress._percent_str)s"
  ].join(FIELD_SEPARATOR);

  return [
    "--newline",
    "--progress",
    "--progress-delta",
    "1",
    "--progress-template",
    `download:${downloadTemplate}`,
    "--progress-template",
    `postprocess:${postprocessTemplate}`
  ];
}

export function parseProgressLine(line) {
  if (typeof line !== "string" || !line.startsWith(PROGRESS_MARKER)) {
    return null;
  }

  const parts = line.split(FIELD_SEPARATOR);

  if (parts[1] === "download") {
    return parseDownloadProgress(parts);
  }

  if (parts[1] === "postprocess") {
    return parsePostprocessProgress(parts);
  }

  return null;
}
