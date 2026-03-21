# yt-dlp web ui

Minimal single-page yt-dlp UI built with native Node.js APIs only.

## Requirements

- Node.js 18+
- `yt-dlp` available on `PATH`

## Run

```sh
npm start
```

The app listens on the host and port defined in [`config.json`](/Users/ahmet/Developer/ytdlp-web-ui/config.json).

## Password auth

Password auth is off by default.

To enable it:

1. Copy `.env.example` to `.env`.
2. Set `APP_PASSWORD`.
3. Set a long random `SESSION_SECRET`.
4. Change `auth.requirePassword` to `true` in [`config.json`](/Users/ahmet/Developer/ytdlp-web-ui/config.json).
5. If you are serving the app over HTTPS, set `auth.secureCookies` to `true`.

The browser stores the session token in both a cookie and `localStorage`, so you only need to unlock once per device/session window.

## Notes

- The server only accepts explicit JSON fields and only invokes `yt-dlp` with fixed argument lists.
- Only `http` and `https` URLs are accepted.
- Private, loopback, and local-only hosts are rejected.
- Download settings are saved in `localStorage`.
- Old downloads are cleaned out automatically from the configured download directory.
