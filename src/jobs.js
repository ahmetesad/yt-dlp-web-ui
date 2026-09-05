import crypto from "node:crypto";

const terminalStatuses = new Set(["completed", "failed"]);

function cloneFiles(files) {
  return Array.isArray(files)
    ? files.map((file) => {
        const clonedFile = {
          name: file.name,
          size: file.size,
          url: file.url
        };

        for (const key of [
          "audioCodec",
          "formatId",
          "hasAudio",
          "hasVideo",
          "mediaId",
          "sourceFormat",
          "title",
          "videoCodec"
        ]) {
          if (Object.hasOwn(file, key)) {
            clonedFile[key] = file[key];
          }
        }

        return clonedFile;
      })
    : [];
}

function cloneProgress(progress) {
  if (!progress) {
    return null;
  }

  return {
    downloadedBytes: progress.downloadedBytes ?? null,
    etaSeconds: progress.etaSeconds ?? null,
    message: progress.message ?? "",
    percent: progress.percent ?? null,
    phase: progress.phase ?? "downloading",
    totalBytes: progress.totalBytes ?? null
  };
}

function serializeJob(job) {
  return {
    createdAt: job.createdAt,
    error: job.error,
    files: cloneFiles(job.files),
    jobId: job.id,
    progress: cloneProgress(job.progress),
    status: job.status,
    updatedAt: job.updatedAt
  };
}

export function createJobStore({ jobTtlMs = 60 * 60 * 1000 } = {}) {
  const jobs = new Map();
  const subscribers = new Map();

  function cleanupExpired() {
    const cutoff = Date.now() - jobTtlMs;

    for (const [jobId, job] of jobs.entries()) {
      if (!terminalStatuses.has(job.status) || job.updatedAt >= cutoff) {
        continue;
      }

      jobs.delete(jobId);
      subscribers.delete(jobId);
    }
  }

  function emit(jobId, eventName, payload) {
    const listeners = subscribers.get(jobId);

    if (!listeners) {
      return;
    }

    for (const listener of listeners) {
      listener(eventName, payload);
    }
  }

  return {
    cleanupExpired,
    completeJob(jobId, files) {
      const job = jobs.get(jobId);

      if (!job) {
        return null;
      }

      job.error = null;
      job.files = cloneFiles(files);
      job.progress = {
        downloadedBytes: null,
        etaSeconds: null,
        message: "Download complete.",
        percent: 100,
        phase: "postprocessing",
        totalBytes: null
      };
      job.status = "completed";
      job.updatedAt = Date.now();

      emit(jobId, "complete", {
        files: cloneFiles(job.files),
        status: job.status
      });

      return serializeJob(job);
    },
    createJob(settings) {
      cleanupExpired();

      const job = {
        createdAt: Date.now(),
        error: null,
        files: [],
        id: crypto.randomBytes(12).toString("hex"),
        progress: {
          downloadedBytes: null,
          etaSeconds: null,
          message: "Waiting to start...",
          percent: null,
          phase: "downloading",
          totalBytes: null
        },
        settings: { ...settings },
        status: "queued",
        updatedAt: Date.now()
      };

      jobs.set(job.id, job);
      subscribers.set(job.id, new Set());

      return serializeJob(job);
    },
    failJob(jobId, errorMessage) {
      const job = jobs.get(jobId);

      if (!job) {
        return null;
      }

      job.error = errorMessage;
      job.status = "failed";
      job.updatedAt = Date.now();

      emit(jobId, "error", {
        error: job.error,
        status: job.status
      });

      return serializeJob(job);
    },
    getSnapshot(jobId) {
      cleanupExpired();

      const job = jobs.get(jobId);
      return job ? serializeJob(job) : null;
    },
    subscribe(jobId, listener) {
      cleanupExpired();

      const listeners = subscribers.get(jobId);

      if (!listeners) {
        return null;
      }

      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    updateProgress(jobId, progress) {
      const job = jobs.get(jobId);

      if (!job) {
        return null;
      }

      job.error = null;
      job.progress = cloneProgress(progress);
      job.status =
        progress.phase === "postprocessing" ? "postprocessing" : "running";
      job.updatedAt = Date.now();

      emit(jobId, "progress", cloneProgress(job.progress));
      return serializeJob(job);
    }
  };
}
