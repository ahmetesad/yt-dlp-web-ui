import assert from "node:assert/strict";
import test from "node:test";
import {
  buildYtDlpArgs,
  getClientOptions,
  validateDownloadRequest
} from "../src/download.js";

const config = {
  download: {
    defaultAudioOnly: false,
    defaultFormat: "mp4",
    defaultIncludePlaylist: false,
    defaultQuality: "1080",
    defaultConvertVideo: "none",
    maxUrlLength: 2048
  }
};

test("getClientOptions exposes convert defaults and options", () => {
  const clientOptions = getClientOptions(config);

  assert.equal(clientOptions.defaults.convertVideo, "none");
  assert.deepEqual(clientOptions.convertVideoOptions, [
    "none",
    "remux",
    "h264"
  ]);
});

test("validateDownloadRequest accepts remux mode for video downloads", async () => {
  const request = await validateDownloadRequest(
    {
      format: "mp4",
      mediaUrl: "https://1.1.1.1/watch?v=test",
      quality: "1080",
      convertVideo: "remux"
    },
    config
  );

  assert.equal(request.audioOnly, false);
  assert.equal(request.format, "mp4");
  assert.equal(request.convertVideo, "remux");
});

test("validateDownloadRequest accepts browser-side convert mode for video downloads", async () => {
  const request = await validateDownloadRequest(
    {
      format: "mp4",
      mediaUrl: "https://1.1.1.1/watch?v=test",
      quality: "1080",
      convertVideo: "h264"
    },
    config
  );

  assert.equal(request.audioOnly, false);
  assert.equal(request.format, "mp4");
  assert.equal(request.convertVideo, "h264");
});

test("validateDownloadRequest accepts browser-side convert mode for webm video downloads", async () => {
  const request = await validateDownloadRequest(
    {
      format: "webm",
      mediaUrl: "https://1.1.1.1/watch?v=test",
      quality: "1080",
      convertVideo: "h264"
    },
    config
  );

  assert.equal(request.format, "webm");
  assert.equal(request.convertVideo, "h264");
});

test("validateDownloadRequest rejects conversion on audio-only downloads", async () => {
  await assert.rejects(
    validateDownloadRequest(
      {
        audioOnly: true,
        format: "mp3",
        mediaUrl: "https://1.1.1.1/watch?v=test",
        quality: "1080",
        convertVideo: "h264"
      },
      config
    ),
    {
      message: "Conversion is only available for video downloads."
    }
  );
});

test("yt-dlp downloads video and audio separately without ffmpeg post-processing", () => {
  const args = buildYtDlpArgs(
    "https://example.com/video",
    {
      audioOnly: false,
      convertVideo: "none",
      format: "mp4",
      includePlaylist: false,
      quality: "1080"
    },
    { download: { maxPlaylistItems: 25 } },
    "/downloads/job",
    ""
  );
  const format = args[args.indexOf("--format") + 1];

  assert.match(format, /,/);
  assert.doesNotMatch(format, /\+/);
  assert.ok(!args.includes("--merge-output-format"));
  assert.ok(!args.includes("--extract-audio"));
  assert.ok(!args.includes("--audio-format"));
});

test("yt-dlp requests MP4-compatible source tracks for browser conversion", () => {
  const args = buildYtDlpArgs(
    "https://example.com/video",
    {
      audioOnly: false,
      convertVideo: "h264",
      format: "webm",
      includePlaylist: false,
      quality: "720"
    },
    { download: { maxPlaylistItems: 25 } },
    "/downloads/job",
    ""
  );
  const format = args[args.indexOf("--format") + 1];

  assert.match(format, /bestvideo\[height<=720\]\[ext=mp4\]/);
  assert.match(format, /bestaudio\[ext=m4a\]/);
});

test("audio-only downloads leave encoding to the browser", () => {
  const args = buildYtDlpArgs(
    "https://example.com/audio",
    {
      audioOnly: true,
      convertVideo: "none",
      format: "mp3",
      includePlaylist: false,
      quality: "best"
    },
    { download: { maxPlaylistItems: 25 } },
    "/downloads/job",
    ""
  );

  assert.equal(args[args.indexOf("--format") + 1], "bestaudio/best");
  assert.ok(!args.includes("--extract-audio"));
});
