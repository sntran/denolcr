/**
 * A client of the SFTP protocol, version 3, as
 * draft-ietf-secsh-filexfer-02, with the extensions of OpenSSH
 * `posix-rename@openssh.com` and `hardlink@openssh.com`.
 */

import { ProtocolError, Reader, Writer } from "./ssh/wire.js";

/** The numbers of the messages of SFTP. */
const FXP = {
  INIT: 1,
  VERSION: 2,
  OPEN: 3,
  CLOSE: 4,
  READ: 5,
  WRITE: 6,
  LSTAT: 7,
  FSTAT: 8,
  SETSTAT: 9,
  FSETSTAT: 10,
  OPENDIR: 11,
  READDIR: 12,
  REMOVE: 13,
  MKDIR: 14,
  RMDIR: 15,
  REALPATH: 16,
  STAT: 17,
  RENAME: 18,
  READLINK: 19,
  SYMLINK: 20,
  STATUS: 101,
  HANDLE: 102,
  DATA: 103,
  NAME: 104,
  ATTRS: 105,
  EXTENDED: 200,
  EXTENDED_REPLY: 201,
};

/** The flags of OPEN. */
export const OPEN = {
  READ: 0x01,
  WRITE: 0x02,
  APPEND: 0x04,
  CREAT: 0x08,
  TRUNC: 0x10,
  EXCL: 0x20,
};

/** The codes of STATUS. */
export const STATUS = {
  OK: 0,
  EOF: 1,
  NO_SUCH_FILE: 2,
  PERMISSION_DENIED: 3,
  FAILURE: 4,
  BAD_MESSAGE: 5,
  NO_CONNECTION: 6,
  CONNECTION_LOST: 7,
  OP_UNSUPPORTED: 8,
};

/** The flags of the attributes. */
const ATTR = {
  SIZE: 0x01,
  UIDGID: 0x02,
  PERMISSIONS: 0x04,
  ACMODTIME: 0x08,
  EXTENDED: 0x80000000,
};

/** The type bits of the permissions of a file, as `st_mode`. */
const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

/** The largest packet of SFTP that the client reads. */
const MAX_PACKET = 256 * 1024 + 64;

/** An error of the server, with its code of STATUS. */
export class SFTPError extends Error {
  /** @param {number} code @param {string} message */
  constructor(code, message) {
    super(message || `SFTP error ${code}`);
    this.code = code;
  }
}

/**
 * The attributes of a file.
 * @typedef {Object} Attributes
 * @property {bigint} [size]
 * @property {number} [uid]
 * @property {number} [gid]
 * @property {number} [permissions]
 * @property {number} [atime] Seconds after 1970.
 * @property {number} [mtime] Seconds after 1970.
 */

/**
 * Tells if attributes are of a folder.
 * @param {Attributes} attrs
 */
export function isDirectory(attrs) {
  return attrs.permissions !== undefined &&
    (attrs.permissions & S_IFMT) === S_IFDIR;
}

/**
 * Tells if attributes are of a regular file.
 * @param {Attributes} attrs
 */
export function isRegular(attrs) {
  return attrs.permissions === undefined ||
    (attrs.permissions & S_IFMT) === S_IFREG;
}

/**
 * Tells if attributes are of a symbolic link.
 * @param {Attributes} attrs
 */
export function isLink(attrs) {
  return attrs.permissions !== undefined &&
    (attrs.permissions & S_IFMT) === S_IFLNK;
}

/**
 * Reads the attributes of a message.
 * @param {Reader} reader
 * @returns {Attributes}
 */
function readAttributes(reader) {
  const flags = reader.uint32();
  /** @type {Attributes} */
  const attrs = {};
  if (flags & ATTR.SIZE) attrs.size = reader.uint64();
  if (flags & ATTR.UIDGID) {
    attrs.uid = reader.uint32();
    attrs.gid = reader.uint32();
  }
  if (flags & ATTR.PERMISSIONS) attrs.permissions = reader.uint32();
  if (flags & ATTR.ACMODTIME) {
    attrs.atime = reader.uint32();
    attrs.mtime = reader.uint32();
  }
  if (flags & ATTR.EXTENDED) {
    const count = reader.uint32();
    for (let i = 0; i < count; i++) {
      reader.bytes();
      reader.bytes();
    }
  }
  return attrs;
}

/**
 * Writes attributes.
 * @param {Writer} writer
 * @param {Attributes} attrs
 */
function writeAttributes(writer, attrs) {
  let flags = 0;
  if (attrs.size !== undefined) flags |= ATTR.SIZE;
  if (attrs.uid !== undefined && attrs.gid !== undefined) flags |= ATTR.UIDGID;
  if (attrs.permissions !== undefined) flags |= ATTR.PERMISSIONS;
  if (attrs.atime !== undefined && attrs.mtime !== undefined) {
    flags |= ATTR.ACMODTIME;
  }
  writer.uint32(flags);
  if (attrs.size !== undefined) writer.uint64(attrs.size);
  if (flags & ATTR.UIDGID) {
    writer.uint32(/** @type {number} */ (attrs.uid));
    writer.uint32(/** @type {number} */ (attrs.gid));
  }
  if (attrs.permissions !== undefined) writer.uint32(attrs.permissions);
  if (flags & ATTR.ACMODTIME) {
    writer.uint32(/** @type {number} */ (attrs.atime));
    writer.uint32(/** @type {number} */ (attrs.mtime));
  }
}

/**
 * An entry of a folder.
 * @typedef {Object} Entry
 * @property {string} filename
 * @property {Attributes} attrs
 */

/** A session of SFTP on a channel of SSH. */
export class SFTP {
  /** @type {import("./ssh/client.js").Channel} */
  #channel;
  #nextId = 1;
  /** @type {Map<number, { resolve: (answer: Answer) => void, reject: (error: Error) => void }>} */
  #pending = new Map();
  /** The extensions of the server, by their names. */
  /** @type {Map<string, string>} */
  extensions = new Map();
  /** @type {Error | null} */
  #error = null;
  /** The bytes of a packet that is not complete. */
  #buffer = new Uint8Array(0);

  /** @param {import("./ssh/client.js").Channel} channel */
  constructor(channel) {
    this.#channel = channel;
  }

  /**
   * Starts SFTP on a channel with the subsystem `sftp`.
   * @param {import("./ssh/client.js").Channel} channel
   * @returns {Promise<SFTP>}
   */
  static async start(channel) {
    const sftp = new SFTP(channel);
    await sftp.#writePacket(new Writer().byte(FXP.INIT).uint32(3).bytes());
    const reader = new Reader(await sftp.#readPacket());
    if (reader.byte() !== FXP.VERSION) {
      throw new ProtocolError("The server did not send its SFTP version");
    }
    const version = reader.uint32();
    if (version < 3) {
      throw new ProtocolError(`SFTP version ${version} is not supported`);
    }
    while (reader.remaining > 0) {
      const name = reader.string();
      sftp.extensions.set(name, new TextDecoder().decode(reader.bytes()));
    }
    sftp.#readLoop();
    return sftp;
  }

  /** The channel of the session. */
  get channel() {
    return this.#channel;
  }

  /** @param {Uint8Array} payload */
  async #writePacket(payload) {
    await this.#channel.write(
      new Writer(payload.length + 4).uint32(payload.length).raw(payload)
        .bytes(),
    );
  }

  /**
   * Reads one packet of SFTP from the channel.
   * @returns {Promise<Uint8Array>}
   */
  async #readPacket() {
    while (true) {
      if (this.#buffer.length >= 4) {
        const length = new DataView(
          this.#buffer.buffer,
          this.#buffer.byteOffset,
          4,
        ).getUint32(0);
        if (length === 0 || length > MAX_PACKET) {
          throw new ProtocolError(`An SFTP packet of ${length} bytes is wrong`);
        }
        if (this.#buffer.length >= 4 + length) {
          const packet = this.#buffer.subarray(4, 4 + length);
          this.#buffer = this.#buffer.subarray(4 + length);
          return packet;
        }
      }
      const data = await this.#channel.read();
      if (data === null) {
        throw new ProtocolError("The SFTP server closed the channel");
      }
      if (this.#buffer.length === 0) {
        this.#buffer = data;
      } else {
        const joined = new Uint8Array(this.#buffer.length + data.length);
        joined.set(this.#buffer);
        joined.set(data, this.#buffer.length);
        this.#buffer = joined;
      }
    }
  }

  /** Reads the answers, and gives each one to its request. */
  async #readLoop() {
    try {
      while (true) {
        const reader = new Reader(await this.#readPacket());
        const type = reader.byte();
        const id = reader.uint32();
        const pending = this.#pending.get(id);
        if (!pending) throw new ProtocolError("An answer has no request");
        this.#pending.delete(id);
        pending.resolve({ type, reader });
      }
    } catch (error) {
      this.#error = error instanceof Error ? error : new Error(String(error));
      for (const pending of this.#pending.values()) pending.reject(this.#error);
      this.#pending.clear();
    }
  }

  /**
   * Sends a request, and gives its answer. A STATUS with an error throws
   * its SFTPError.
   * @param {number} type
   * @param {(writer: Writer) => void} write Writes the data after the ID.
   * @returns {Promise<Answer>}
   */
  async #call(type, write) {
    if (this.#error) throw this.#error;
    const id = this.#nextId;
    this.#nextId = ((this.#nextId + 1) >>> 0) || 1;
    const writer = new Writer(type === FXP.WRITE ? 64 * 1024 : 256)
      .byte(type)
      .uint32(id);
    write(writer);
    /** @type {Promise<Answer>} */
    const answer = new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    await this.#writePacket(writer.bytes());
    const result = await answer;
    if (result.type === FXP.STATUS) {
      const code = result.reader.uint32();
      let message = "";
      try {
        message = result.reader.string();
      } catch {
        // Some servers send no message.
      }
      if (code !== STATUS.OK) throw new SFTPError(code, message);
    }
    return result;
  }

  /**
   * The attributes of a path, with the links followed.
   * @param {string} path
   * @returns {Promise<Attributes>}
   */
  async stat(path) {
    const { type, reader } = await this.#call(FXP.STAT, (w) => w.string(path));
    expect(type, FXP.ATTRS);
    return readAttributes(reader);
  }

  /**
   * The attributes of a path, with no link followed.
   * @param {string} path
   * @returns {Promise<Attributes>}
   */
  async lstat(path) {
    const { type, reader } = await this.#call(FXP.LSTAT, (w) => w.string(path));
    expect(type, FXP.ATTRS);
    return readAttributes(reader);
  }

  /**
   * The attributes of an open file.
   * @param {Uint8Array} handle
   * @returns {Promise<Attributes>}
   */
  async fstat(handle) {
    const { type, reader } = await this.#call(
      FXP.FSTAT,
      (w) => w.string(handle),
    );
    expect(type, FXP.ATTRS);
    return readAttributes(reader);
  }

  /**
   * Changes the attributes of a path, for example its time.
   * @param {string} path
   * @param {Attributes} attrs
   */
  async setstat(path, attrs) {
    await this.#call(
      FXP.SETSTAT,
      (w) => writeAttributes(w.string(path), attrs),
    );
  }

  /**
   * Opens a file.
   * @param {string} path
   * @param {number} flags The flags of OPEN.
   * @param {Attributes} [attrs] The attributes of a new file.
   * @returns {Promise<Uint8Array>} The handle of the file.
   */
  async open(path, flags, attrs = {}) {
    const { type, reader } = await this.#call(
      FXP.OPEN,
      (w) => writeAttributes(w.string(path).uint32(flags), attrs),
    );
    expect(type, FXP.HANDLE);
    return reader.bytes().slice();
  }

  /**
   * Closes a handle of a file or of a folder.
   * @param {Uint8Array} handle
   */
  async close(handle) {
    await this.#call(FXP.CLOSE, (w) => w.string(handle));
  }

  /**
   * Reads bytes of an open file.
   * @param {Uint8Array} handle
   * @param {bigint | number} offset
   * @param {number} length
   * @returns {Promise<Uint8Array | null>} null at the end of the file.
   */
  async read(handle, offset, length) {
    try {
      const { type, reader } = await this.#call(
        FXP.READ,
        (w) => w.string(handle).uint64(offset).uint32(length),
      );
      expect(type, FXP.DATA);
      return reader.bytes().slice();
    } catch (error) {
      if (error instanceof SFTPError && error.code === STATUS.EOF) return null;
      throw error;
    }
  }

  /**
   * Writes bytes in an open file.
   * @param {Uint8Array} handle
   * @param {bigint | number} offset
   * @param {Uint8Array} data
   */
  async write(handle, offset, data) {
    await this.#call(
      FXP.WRITE,
      (w) => w.string(handle).uint64(offset).string(data),
    );
  }

  /**
   * The entries of a folder, with no `.` and no `..`.
   * @param {string} path
   * @returns {Promise<Entry[]>}
   */
  async readdir(path) {
    const { type, reader } = await this.#call(
      FXP.OPENDIR,
      (w) => w.string(path),
    );
    expect(type, FXP.HANDLE);
    const handle = reader.bytes().slice();
    /** @type {Entry[]} */
    const entries = [];
    try {
      while (true) {
        let answer;
        try {
          answer = await this.#call(FXP.READDIR, (w) => w.string(handle));
        } catch (error) {
          if (error instanceof SFTPError && error.code === STATUS.EOF) break;
          throw error;
        }
        expect(answer.type, FXP.NAME);
        const count = answer.reader.uint32();
        for (let i = 0; i < count; i++) {
          const filename = answer.reader.string();
          answer.reader.string();
          const attrs = readAttributes(answer.reader);
          if (filename !== "." && filename !== "..") {
            entries.push({ filename, attrs });
          }
        }
      }
    } finally {
      await this.close(handle).catch(() => {});
    }
    return entries;
  }

  /**
   * Makes a folder.
   * @param {string} path
   */
  async mkdir(path) {
    await this.#call(FXP.MKDIR, (w) => writeAttributes(w.string(path), {}));
  }

  /**
   * Deletes an empty folder.
   * @param {string} path
   */
  async rmdir(path) {
    await this.#call(FXP.RMDIR, (w) => w.string(path));
  }

  /**
   * Deletes a file.
   * @param {string} path
   */
  async remove(path) {
    await this.#call(FXP.REMOVE, (w) => w.string(path));
  }

  /**
   * Renames a file or a folder. With `posix-rename@openssh.com`, the new
   * path can exist: then the file at that path is replaced.
   * @param {string} from
   * @param {string} to
   * @param {boolean} [replace] True to replace a file at the new path.
   */
  async rename(from, to, replace = false) {
    if (replace && this.extensions.has("posix-rename@openssh.com")) {
      await this.#call(
        FXP.EXTENDED,
        (w) => w.string("posix-rename@openssh.com").string(from).string(to),
      );
      return;
    }
    if (replace) {
      // As rclone: with no POSIX rename, the old file goes first.
      await this.remove(to).catch((error) => {
        if (
          !(error instanceof SFTPError && error.code === STATUS.NO_SUCH_FILE)
        ) {
          throw error;
        }
      });
    }
    await this.#call(FXP.RENAME, (w) => w.string(from).string(to));
  }

  /**
   * Makes a hard link, with `hardlink@openssh.com`.
   * @param {string} from
   * @param {string} to
   */
  async hardlink(from, to) {
    if (!this.extensions.has("hardlink@openssh.com")) {
      throw new SFTPError(STATUS.OP_UNSUPPORTED, "No hard links");
    }
    await this.#call(
      FXP.EXTENDED,
      (w) => w.string("hardlink@openssh.com").string(from).string(to),
    );
  }

  /**
   * The absolute path of a path, as the server knows it.
   * @param {string} path For example `.` for the login folder.
   * @returns {Promise<string>}
   */
  async realpath(path) {
    const { type, reader } = await this.#call(
      FXP.REALPATH,
      (w) => w.string(path),
    );
    expect(type, FXP.NAME);
    if (reader.uint32() < 1) throw new ProtocolError("REALPATH gave no name");
    return reader.string();
  }

  /** Closes the channel of the session. */
  async end() {
    await this.#channel.close();
  }
}

/**
 * An answer of the server.
 * @typedef {{ type: number, reader: Reader }} Answer
 */

/**
 * Makes sure that an answer has a type.
 * @param {number} type
 * @param {number} expected
 */
function expect(type, expected) {
  if (type !== expected) {
    throw new ProtocolError(`The answer ${type} is not the answer ${expected}`);
  }
}
