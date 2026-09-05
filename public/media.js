import { groupSourceFiles } from "./media-groups.js";

const {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  Conversion,
  Input,
  Mp3OutputFormat,
  Mp4OutputFormat,
  Output,
  Quality,
  WavOutputFormat,
  WebMOutputFormat,
  canEncodeAudio,
  canEncodeVideo
} = globalThis.Mediabunny;
const { registerMp3Encoder } = globalThis.MediabunnyMp3Encoder;

let mp3EncoderRegistered = false;

function sanitizeFileName(value, fallback) {
  const sanitized = String(value || "")
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 140);

  return sanitized || fallback;
}

function getOutputName(group, settings) {
  const baseName = sanitizeFileName(group.title, group.mediaId || "download");

  if (settings.audioOnly) {
    return `${baseName}.${settings.format}`;
  }

  if (settings.convertVideo === "remux") {
    return `${baseName}_mp4.mp4`;
  }

  if (settings.convertVideo === "h264") {
    return `${baseName}_h264.mp4`;
  }

  return `${baseName}.${settings.format}`;
}

function chooseSources(group, inspectedSources, settings) {
  if (settings.audioOnly) {
    const audio = inspectedSources.find((source) => source.hasAudio);

    if (!audio) {
      throw new Error(`No audio track was downloaded for ${group.title}.`);
    }

    return { audio, video: null };
  }

  const video =
    inspectedSources.find((source) => source.hasVideo && !source.hasAudio) ||
    inspectedSources.find((source) => source.hasVideo);
  const audio =
    inspectedSources.find((source) => source.hasAudio && !source.hasVideo) ||
    (video?.hasAudio
      ? video
      : inspectedSources.find((source) => source.hasAudio));

  if (!video) {
    throw new Error(`No video track was downloaded for ${group.title}.`);
  }

  return { audio: audio || null, video };
}

async function fetchSource(file) {
  const response = await fetch(file.url, {
    credentials: "same-origin"
  });

  if (!response.ok) {
    throw new Error(
      `Could not load ${file.name} for browser processing (${response.status}).`
    );
  }

  return response.blob();
}

function createInput(blob) {
  return new Input({
    formats: ALL_FORMATS,
    source: new BlobSource(blob)
  });
}

async function ensureMp3Encoder() {
  if (mp3EncoderRegistered || (await canEncodeAudio("mp3"))) {
    return;
  }

  registerMp3Encoder();
  mp3EncoderRegistered = true;
}

async function createOutput(settings) {
  if (settings.audioOnly) {
    if (settings.format === "mp3") {
      await ensureMp3Encoder();
      return {
        audio: {
          codec: "mp3",
          forceTranscode: true,
          quality: new Quality({ bitrate: 192_000 })
        },
        format: new Mp3OutputFormat(),
        video: { discard: true }
      };
    }

    if (settings.format === "wav") {
      return {
        audio: {
          codec: "pcm-s16",
          forceTranscode: true
        },
        format: new WavOutputFormat(),
        video: { discard: true }
      };
    }

    return {
      audio: { codec: "aac" },
      format: new Mp4OutputFormat(),
      video: { discard: true }
    };
  }

  if (settings.convertVideo === "h264") {
    if (!(await canEncodeVideo("avc"))) {
      throw new Error(
        "This browser cannot encode H.264 with WebCodecs. Try remux or conversion off."
      );
    }

    return {
      audio: { codec: "aac" },
      format: new Mp4OutputFormat(),
      video: {
        codec: "avc",
        forceTranscode: true,
        quality: new Quality("high")
      }
    };
  }

  return {
    audio: {},
    format:
      settings.convertVideo === "remux" || settings.format === "mp4"
        ? new Mp4OutputFormat()
        : new WebMOutputFormat(),
    video: {}
  };
}

async function assertRemuxCompatible(inputs, format) {
  const supportedCodecs = new Set(format.getSupportedCodecs());
  const videoTrack = await inputs.video.getPrimaryVideoTrack();
  const audioTrack = inputs.audio
    ? await inputs.audio.getPrimaryAudioTrack()
    : null;
  const codecs = await Promise.all([
    videoTrack?.getCodec() || null,
    audioTrack?.getCodec() || null
  ]);
  const unsupportedCodec = codecs.find(
    (codec) => codec && !supportedCodecs.has(codec)
  );

  if (unsupportedCodec) {
    throw new Error(
      `MP4 cannot remux the ${unsupportedCodec} codec without re-encoding. Choose H.264 MP4 instead.`
    );
  }
}

function assertConversionUsesTrack(conversion, type, title) {
  if (conversion.utilizedTracks.some((track) => track.type === type)) {
    return;
  }

  const reason = conversion.discardedTracks
    .filter(({ track }) => track.type === type)
    .map(({ reason: discardReason }) => discardReason.replaceAll("_", " "))
    .join(", ");

  throw new Error(
    `MediaBunny could not use the ${type} track for ${title}${
      reason ? ` (${reason})` : ""
    }.`
  );
}

async function convertGroup(group, settings, onProgress) {
  const inspectedSources = [];
  const conversions = [];
  let output = null;

  try {
    const blobs = await Promise.all(group.files.map(fetchSource));

    for (const [index, file] of group.files.entries()) {
      const input = createInput(blobs[index]);
      const inspectedSource = {
        file,
        hasAudio: false,
        hasVideo: false,
        input
      };
      inspectedSources.push(inspectedSource);
      const [videoTrack, audioTrack] = await Promise.all([
        input.getPrimaryVideoTrack(),
        input.getPrimaryAudioTrack()
      ]);

      inspectedSource.hasAudio = Boolean(audioTrack);
      inspectedSource.hasVideo = Boolean(videoTrack);
    }

    const sources = chooseSources(group, inspectedSources, settings);
    const inputs = {
      audio: sources.audio?.input || null,
      video: sources.video?.input || null
    };
    const outputOptions = await createOutput(settings);
    const target = new BufferTarget();
    output = new Output({
      format: outputOptions.format,
      target
    });

    if (settings.convertVideo === "remux") {
      await assertRemuxCompatible(inputs, outputOptions.format);
    }

    if (settings.audioOnly) {
      const conversion = await Conversion.init({
        audio: outputOptions.audio,
        composable: true,
        input: inputs.audio,
        output,
        showWarnings: false,
        tracks: "primary",
        video: outputOptions.video
      });
      assertConversionUsesTrack(conversion, "audio", group.title);
      conversions.push(conversion);
    } else if (inputs.audio === inputs.video || !inputs.audio) {
      const conversion = await Conversion.init({
        audio: outputOptions.audio,
        composable: true,
        input: inputs.video,
        output,
        showWarnings: false,
        tracks: "primary",
        video: outputOptions.video
      });
      assertConversionUsesTrack(conversion, "video", group.title);
      conversions.push(conversion);
    } else {
      const videoConversion = await Conversion.init({
        audio: { discard: true },
        composable: true,
        input: inputs.video,
        output,
        showWarnings: false,
        tracks: "primary",
        video: outputOptions.video
      });
      const audioConversion = await Conversion.init({
        audio: outputOptions.audio,
        composable: true,
        input: inputs.audio,
        output,
        showWarnings: false,
        tracks: "primary",
        video: { discard: true }
      });
      assertConversionUsesTrack(videoConversion, "video", group.title);
      assertConversionUsesTrack(audioConversion, "audio", group.title);
      conversions.push(videoConversion, audioConversion);
    }

    const progressValues = conversions.map(() => 0);

    conversions.forEach((conversion, index) => {
      conversion.onProgress = (progress) => {
        progressValues[index] = progress;
        onProgress?.(
          progressValues.reduce((sum, value) => sum + value, 0) /
            progressValues.length
        );
      };
    });

    await output.start();
    await Promise.all(conversions.map((conversion) => conversion.execute()));
    await output.finalize();

    if (!target.buffer) {
      throw new Error("MediaBunny did not produce an output file.");
    }

    const blob = new Blob([target.buffer], {
      type: outputOptions.format.mimeType
    });

    return {
      browserGenerated: true,
      name: getOutputName(group, settings),
      size: blob.size,
      url: URL.createObjectURL(blob)
    };
  } catch (error) {
    await Promise.allSettled(
      conversions.map((conversion) => conversion.cancel())
    );
    await output?.cancel().catch(() => {});
    throw error;
  } finally {
    for (const source of inspectedSources) {
      source.input.dispose();
    }
  }
}

export async function processDownloadedFiles(
  files,
  settings,
  onProgress
) {
  const groups = groupSourceFiles(files);
  const outputs = [];
  const phase =
    settings.audioOnly || settings.convertVideo === "h264"
      ? "converting"
      : "postprocessing";

  for (const [index, group] of groups.entries()) {
    onProgress?.({
      message:
        phase === "converting"
          ? `Encoding ${index + 1}/${groups.length} in your browser...`
          : `Muxing ${index + 1}/${groups.length} in your browser...`,
      percent: (index / groups.length) * 100,
      phase
    });
    const output = await convertGroup(group, settings, (progress) => {
      onProgress?.({
        message:
          phase === "converting"
            ? `Encoding ${index + 1}/${groups.length} in your browser...`
            : `Muxing ${index + 1}/${groups.length} in your browser...`,
        percent: ((index + progress) / groups.length) * 100,
        phase
      });
    });
    outputs.push(output);
  }

  return outputs;
}
