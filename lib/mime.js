/**
 * The media type of a file from its name, as `MimeTypeFromName` of rclone:
 * the built-in table of the `mime` package of Go, the types that rclone adds
 * (fs/mimetype.go of rclone 1.75.1), and `text/plain` for `.txt`, as the
 * `mime.types` file of most systems gives it.
 */

/** The types for each extension, in lowercase. */
const TYPES = {
  // The built-in table of Go.
  ".avif": "image/avif",
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".htm": "text/html; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".mjs": "text/javascript; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".xml": "text/xml; charset=utf-8",
  // The types that rclone adds.
  ".flac": "audio/flac",
  ".mpga": "audio/mpeg",
  ".mpega": "audio/mpeg",
  ".mp2": "audio/mpeg",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mpeg",
  ".oga": "audio/ogg",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".spx": "audio/ogg",
  ".wav": "audio/x-wav",
  ".tiff": "image/tiff",
  ".tif": "image/tiff",
  ".dif": "video/dv",
  ".dv": "video/dv",
  ".fli": "video/fli",
  ".mpeg": "video/mpeg",
  ".mpg": "video/mpeg",
  ".mpe": "video/mpeg",
  ".ts": "video/MP2T",
  ".mp4": "video/mp4",
  ".qt": "video/quicktime",
  ".mov": "video/quicktime",
  ".ogv": "video/ogg",
  ".webm": "video/webm",
  ".avi": "video/x-msvideo",
  ".mpv": "video/x-matroska",
  ".mkv": "video/x-matroska",
  ".srt": "application/x-subrip",
  // The type of most systems.
  ".txt": "text/plain; charset=utf-8",
};

/**
 * Gives the media type of a file from the extension of its name, or
 * `application/octet-stream` for an unknown extension. The extension can be
 * in each case: `A.PNG` is an image.
 * @param {string} name A name or a path of a file.
 * @returns {string}
 */
export function mimeType(name) {
  const base = name.slice(name.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  const extension = dot === -1 ? "" : base.slice(dot).toLowerCase();
  return Object.hasOwn(TYPES, extension)
    ? TYPES[extension]
    : "application/octet-stream";
}
