# yt-dlp web ui

Minimal single-page yt-dlp UI built with native Node.js APIs only. Uses 0 external dependencies.

<img src="./screenshots/ytdlpwebui.png">

## Features

- Single-page UI served by native `node:http`
- Saved download settings in `localStorage`
- Compact live download progress in the sticky action area
- Optional `mp4` remux setting for video downloads to help with iPhone/iPad playback
- Short quality picker by default, with a toggle to reveal the full list

## Requirements

- Node.js 18+
- `yt-dlp` available on `PATH`

## Run

```sh
npm start
```

The app listens on the host and port defined in [`config.json`](./config.json).

## Password auth

Password auth is off by default.

To enable it:

1. Copy `.env.example` to `.env`.
2. Set `APP_PASSWORD`.
3. Set a long random `SESSION_SECRET`.
4. Change `auth.requirePassword` to `true` in [`config.json`](./config.json).
5. If you are serving the app over HTTPS, set `auth.secureCookies` to `true`.

The browser stores the session token in both a cookie and `localStorage`, so you only need to unlock once per device/session window.

## Rate limiting

Request throttling is disabled by default for personal use.

If you want it, tune the values in [`config.json`](./config.json):

- `rateLimit.loginMaxAttempts`
- `rateLimit.loginWindowMinutes`
- `rateLimit.downloadMaxRequests`
- `rateLimit.downloadWindowMinutes`

Set either max value to `0` to keep that limiter disabled.

## Notes

- The server only accepts explicit JSON fields and only invokes `yt-dlp` with fixed argument lists.
- Outbound `yt-dlp` traffic is forced through a local filtering proxy so redirects and follow-up requests cannot hop into private or loopback addresses.
- Only `http` and `https` URLs are accepted.
- Private, loopback, and local-only hosts are rejected.
- Download settings are saved in `localStorage`.
- The `mp4` remux option changes the container only. It does not transcode unsupported codecs.
- Old downloads are cleaned out automatically from the configured download directory.
