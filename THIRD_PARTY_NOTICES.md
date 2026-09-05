# Third-party notices

## MediaBunny 1.55.7

- Packages: `mediabunny` and `@mediabunny/mp3-encoder`
- License: Mozilla Public License 2.0 (MPL-2.0)
- Source: <https://github.com/Vanilagy/mediabunny/tree/v1.55.7>
- License text: <https://github.com/Vanilagy/mediabunny/blob/v1.55.7/LICENSE>

The Docker image serves unmodified minified browser bundles from the installed npm packages.

MediaBunny is licensed under the MPL-2.0. The application's original code is not derived from or incorporated into MPL-covered files and remains separately licensed under MIT.

## LAME 3.100

`@mediabunny/mp3-encoder` includes a WebAssembly build of the LAME MP3 encoder.

- License: GNU Lesser General Public License (LGPL)
- License text: <https://lame.sourceforge.io/license.txt>
- Source: <https://lame.sourceforge.io/download.php>

The LAME component remains subject to its upstream license. Attribution to LAME is included as requested by the MediaBunny MP3 encoder extension.

## yt-dlp

The Docker image installs `yt-dlp` from PyPI.

- License: The Unlicense
- Source: <https://github.com/yt-dlp/yt-dlp>
- License text: <https://github.com/yt-dlp/yt-dlp/blob/master/LICENSE>

## Type declaration packages

MediaBunny installs:

- `@types/dom-webcodecs` 0.1.13
- `@types/dom-mediacapture-transform` 0.1.12

Both packages are MIT-licensed development type declarations and are not executed by the application.

## FFmpeg

The Docker image does not include FFmpeg, and the application does not invoke it.

MediaBunny's optional AAC and server extensions are not installed. No FFmpeg-derived MediaBunny WebAssembly or native libraries are included.

## Application license

Original application code is licensed under the MIT License as described in the top-level `LICENSE` file. Third-party components retain their respective licenses.