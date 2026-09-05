import assert from "node:assert/strict";
import test from "node:test";
import { groupSourceFiles } from "../public/media-groups.js";

test("groupSourceFiles keeps playlist entries separate", () => {
  const groups = groupSourceFiles([
    { mediaId: "one", title: "One", hasVideo: true },
    { mediaId: "one", title: "One", hasAudio: true },
    { mediaId: "two", title: "Two", hasAudio: true }
  ]);

  assert.equal(groups.length, 2);
  assert.deepEqual(
    groups.map((group) => [group.mediaId, group.files.length]),
    [
      ["one", 2],
      ["two", 1]
    ]
  );
});

test("groupSourceFiles rejects tracks without server metadata", () => {
  assert.throws(() => groupSourceFiles([{ name: "unknown.webm" }]), {
    message: "A downloaded track is missing its media identifier."
  });
});
