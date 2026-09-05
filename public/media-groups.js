export function groupSourceFiles(files = []) {
  const groups = new Map();

  for (const file of files) {
    if (!file?.mediaId) {
      throw new Error("A downloaded track is missing its media identifier.");
    }

    if (!groups.has(file.mediaId)) {
      groups.set(file.mediaId, {
        files: [],
        mediaId: file.mediaId,
        title: file.title || file.mediaId
      });
    }

    groups.get(file.mediaId).files.push(file);
  }

  return [...groups.values()];
}
