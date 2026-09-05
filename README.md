# yt-dlp web ui

Minimal single-page yt-dlp UI. The server downloads source tracks with `yt-dlp` and [MediaBunny](https://github.com/Vanilagy/mediabunny) muxes and
encodes them in the browser.

<img src="./screenshots/ytdlpwebui.png">

## Features

- Single-page UI served by native `node:http`
- Browser-side MP4/WebM muxing and H.264 encoding with MediaBunny
- Browser-side MP3 and WAV audio conversion
- Saved download settings in `localStorage`
- Live progress for both the server download and browser processing
- Direct stream-link lookup
- Optional playlist downloads

## Requirements

- Node.js 18+
- `yt-dlp` available on `PATH`
- A modern browser supported by MediaBunny
- Browser WebCodecs H.264 support when using `h264 mp4`

FFmpeg is not required. Browser encoding APIs are normally available only in a
secure context (HTTPS or localhost).

## Run

Install the pinned browser dependencies and start the server:

```sh
npm ci
npm start
```

The app uses built-in defaults and listens on `127.0.0.1:3000`. Copy
`.env.example` to `.env` to customize local settings. **Runtime environment variables take precedence over `.env`.**

## Docker

Build and run the image:

```sh
docker build -t yt-dlp-web-ui .
docker run --rm -p 3000:3000 \
  -v yt-dlp-downloads:/app/downloads \
  yt-dlp-web-ui
```

The image contains Node.js, Python, `yt-dlp`, MediaBunny's browser bundles, and the LAME-based MediaBunny MP3 encoder.

To enable authentication entirely through environment variables:

```sh
docker run --rm -p 3000:3000 \
  -e REQUIRE_PASSWORD=true \
  -e APP_PASSWORD='choose-a-password' \
  -e SESSION_SECRET='choose-a-long-random-secret' \
  yt-dlp-web-ui
```

[`.env.example`](./.env.example) lists every
setting and default. Pass them with `docker run -e`, `--env-file`, or your
platform's secrets/configuration interface. Boolean variables accept `true`,
`false`, `1`, or `0`.

## How media processing works

For video jobs, `yt-dlp` downloads the selected video and audio tracks as
separate files. It deliberately uses a comma-separated format selector and no
merge or extraction postprocessors, so `yt-dlp` never needs FFmpeg. The browser
then fetches those temporary tracks and uses MediaBunny's Conversion API:

- `off` muxes compatible source tracks into the selected MP4 or WebM container.
- `remux mp4` copies MP4-compatible codecs without re-encoding and rejects
  incompatible codecs.
- `h264 mp4` encodes video as H.264 through the browser's WebCodecs
  implementation and keeps AAC audio when available.
- MP3 uses MediaBunny's LAME/WASM encoder; WAV uses PCM encoding in MediaBunny.
- M4A requests an AAC source from `yt-dlp` and normally copies it without
  re-encoding.

The current implementation buffers each source and completed output in browser
memory. Very large or long videos therefore require substantial memory. Codec
support also varies by browser; when the requested conversion is unavailable, the UI reports an error and suggests a compatible mode.

## Password auth

Password auth is off by default. To enable it, set:

- `REQUIRE_PASSWORD=true`
- `APP_PASSWORD`
- a long random `SESSION_SECRET`
- `SECURE_COOKIES=true` when serving over HTTPS

The browser stores the session token in both a cookie and `localStorage`, so
you only need to unlock once per device/session window.

## Rate limiting and retention

Request throttling is disabled by default. Configure it with
`LOGIN_MAX_ATTEMPTS`, `LOGIN_WINDOW_MINUTES`, `DOWNLOAD_MAX_REQUESTS`, and
`DOWNLOAD_WINDOW_MINUTES`; a maximum of `0` disables that limiter.

Temporary server files are deleted shortly after the browser fetches them by
default. Configure this with `DELETE_AFTER_DOWNLOAD` and
`DELETE_AFTER_DOWNLOAD_MINUTES`. Old job directories are also removed after
`CLEANUP_AFTER_HOURS`.

## Security notes

- The server accepts explicit JSON fields and invokes `yt-dlp` with fixed
  argument lists.
- Outbound `yt-dlp` traffic goes through a filtering proxy so redirects and
  follow-up requests cannot hop into private or loopback addresses.
- Only `http` and `https` URLs are accepted; private, loopback, and local-only
  hosts are rejected.
- `HEAD` requests do not trigger delete-after-download cleanup.
- MediaBunny dependencies are exposed through two fixed vendor URLs. The server
  does not expose `node_modules` generally.

## Licensing

MediaBunny and its MP3 encoder package are MPL-2.0. The MP3
extension embeds LAME, which is LGPL-licensed. H.264 and MP3 may also involve
patent or royalty rules depending on jurisdiction and distribution model.

See [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) for versions, source,
and obligations. The application's own code is released under the permissive
[MIT License](./LICENSE). This summary is not legal advice.
