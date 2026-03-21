import assert from "node:assert/strict";
import test from "node:test";
import { getClientOptions, validateDownloadRequest } from "../src/download.js";

const config = {
  download: {
    defaultAudioOnly: false,
    defaultFormat: "mp4",
    defaultIncludePlaylist: false,
    defaultQuality: "1080",
    defaultRemuxVideo: "none",
    maxUrlLength: 2048
  }
};

test("getClientOptions exposes remux defaults and options", () => {
  const clientOptions = getClientOptions(config);

  assert.equal(clientOptions.defaults.remuxVideo, "none");
  assert.deepEqual(clientOptions.remuxVideoOptions, ["none", "mp4"]);
});

test("validateDownloadRequest accepts mp4 remux for mp4 video downloads", async () => {
  const request = await validateDownloadRequest(
    {
      format: "mp4",
      mediaUrl: "https://1.1.1.1/watch?v=test",
      quality: "1080",
      remuxVideo: "mp4"
    },
    config
  );

  assert.equal(request.audioOnly, false);
  assert.equal(request.format, "mp4");
  assert.equal(request.remuxVideo, "mp4");
});

test("validateDownloadRequest rejects remuxing on non-mp4 video downloads", async () => {
  await assert.rejects(
    validateDownloadRequest(
      {
        format: "webm",
        mediaUrl: "https://1.1.1.1/watch?v=test",
        quality: "1080",
        remuxVideo: "mp4"
      },
      config
    ),
    {
      message: "Remuxing is only available for mp4 video downloads."
    }
  );
});

test("validateDownloadRequest rejects remuxing on audio-only downloads", async () => {
  await assert.rejects(
    validateDownloadRequest(
      {
        audioOnly: true,
        format: "mp3",
        mediaUrl: "https://1.1.1.1/watch?v=test",
        quality: "1080",
        remuxVideo: "mp4"
      },
      config
    ),
    {
      message: "Remuxing is only available for video downloads."
    }
  );
});
