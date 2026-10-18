/**
 * Gives the path of a URL with no percent-encoding, for a backend to use as
 * the path of a file or a folder. The path keeps its `/` at the start, and at
 * the end for a folder.
 *
 * It gives null when the path is not safe: when a name has bad
 * percent-encoding, or when a name is empty, is `.` or `..`, or has a `/` or a
 * NUL character after the decoding. The URL parser removes the segments `.`
 * and `..`, but it keeps `..%2F`, which becomes `../` after the decoding. Thus
 * a backend that uses only the result of this function cannot go out of its
 * root folder.
 * @param {string} pathname The path of a URL, for example `/a%20b/c.txt`.
 * @returns {string | null} The path, for example `/a b/c.txt`, or null.
 */
export function decodePath(pathname) {
  if (!pathname.startsWith("/")) return null;

  const names = pathname.slice(1).split("/");
  // The path of a folder ends with "/", thus its last name is empty.
  const last = names.length - 1;
  for (let i = 0; i < names.length; i++) {
    let name;
    try {
      name = decodeURIComponent(names[i]);
    } catch {
      return null;
    }
    if (name === "" && i === last) continue;
    if (name === "" || name === "." || name === ".." || /[/\0]/.test(name)) {
      return null;
    }
    names[i] = name;
  }

  return `/${names.join("/")}`;
}

/**
 * Puts the percent-encoding in each name of a path, the reverse of
 * `decodePath`.
 * @param {string} path For example `/a b/c.txt`.
 * @returns {string} For example `/a%20b/c.txt`.
 */
export function encodePath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}
