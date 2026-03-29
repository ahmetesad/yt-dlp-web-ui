import assert from "node:assert/strict";
import test from "node:test";
import { getClientOptions, validateDownloadRequest } from "../src/download.js";

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

test("validateDownloadRequest accepts server-side convert mode for video downloads", async () => {
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

test("validateDownloadRequest accepts server-side convert mode for webm video downloads", async () => {
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
