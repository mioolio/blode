# 7-Zip archive runtime

This directory contains the unmodified 7-Zip Extra 26.05 standalone Windows x64 console, its upstream license and readme, and the matching complete source archive. The executable is extracted from the [official release](https://www.7-zip.org/download.html); download and binary hashes are recorded in `manifest.json`.

The desktop and Web builds copy this runtime to `dist/archive-tools`. The host verifies its binary hash before copying it into the host's private cache and executing it. Archive creation uses 7-Zip, with the built-in ZIP writer as a fallback. Other host architectures currently use the built-in writer.

Upstream copyright and distribution terms are in [License.txt](License.txt). The complete corresponding source is [7z2605-src.tar.xz](7z2605-src.tar.xz). No upstream code or binary has been modified.
