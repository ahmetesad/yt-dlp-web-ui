import assert from "node:assert/strict";
import test from "node:test";
import { parseProgressLine } from "../src/progress.js";

test("parseProgressLine reads download progress with total bytes", () => {
  const progress = parseProgressLine(
    "__YTDLP_PROGRESS__\tdownload\tdownloading\t1048576\t2097152\tNA\t12\t 50.0%"
  );

  assert.deepEqual(progress, {
    downloadedBytes: 1048576,
    etaSeconds: 12,
    message: "Downloading media...",
    percent: 50,
    phase: "downloading",
    totalBytes: 2097152
  });
});

test("parseProgressLine falls back to estimated total bytes", () => {
  const progress = parseProgressLine(
    "__YTDLP_PROGRESS__\tdownload\tdownloading\t524288\tNA\t2097152\t9\t 25.0%"
  );

  assert.deepEqual(progress, {
    downloadedBytes: 524288,
    etaSeconds: 9,
    message: "Downloading media...",
    percent: 25,
    phase: "downloading",
    totalBytes: 2097152
  });
});

test("parseProgressLine reads postprocessing progress", () => {
  const progress = parseProgressLine(
    "__YTDLP_PROGRESS__\tpostprocess\tprocessing\tFFmpegExtractAudio\tNA\t 88.4%"
  );

  assert.deepEqual(progress, {
    downloadedBytes: null,
    etaSeconds: null,
    message: "Processing media with FFmpegExtractAudio...",
    percent: 88.4,
    phase: "postprocessing",
    totalBytes: null
  });
});

test("parseProgressLine ignores malformed or unrelated lines", () => {
  assert.equal(parseProgressLine(""), null);
  assert.equal(parseProgressLine("[download] 50%"), null);
  assert.equal(parseProgressLine("__YTDLP_PROGRESS__\tdownload"), null);
});
