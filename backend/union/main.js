/**
 * Union remote
 *
 * The `union` remote merges the contents of several remotes, the upstreams,
 * as the union backend of rclone. A list of a folder has the files and the
 * folders of the folder in each upstream.
 *
 * The option `upstreams` tells the remotes, with a space between them, for
 * example `remote1:dir remote2:other "remote3:with space"`. A tag at the end
 * of an upstream changes what union does with it:
 *
 * - `:ro`: union only reads the upstream.
 * - `:nc`: union reads, changes and deletes the files of the upstream, but
 *   does not put a new file or folder in it.
 * - `:writeback`: union copies a file that it reads from another upstream
 *   into this upstream, as a cache. Only one upstream can have this tag.
 *
 * The policies of rclone choose the upstreams for each request:
 *
 * - `action_policy` (`epall` by default): for a change or a delete of a
 *   file or a folder that exists.
 * - `create_policy` (`epmfs` by default): for a new file or folder.
 * - `search_policy` (`ff` by default): for a read.
 *
 * The policies are `all`, `epall`, `epff`, `eplfs`, `eplno`, `eplus`,
 * `epmfs`, `eprand`, `ff`, `lfs`, `lno`, `lus`, `mfs`, `newest` and `rand`.
 * A policy with `ep` (existing path) uses only the upstreams that have the
 * folder of the path. rfetch reads no free space or number of files of a
 * remote. Thus, as rclone with a remote that does not tell them, the
 * policies of space and of numbers (`mfs`, `lfs`, `lus`, `lno` and their
 * `ep` forms) use the first upstream, and the options `cache_time` and
 * `min_free_space` have no effect.
 */

import { parse } from "@rfetch/lib/fspath";
import { parseList } from "@rfetch/lib/list";
import { readListing, renderListing } from "@rfetch/lib/listing";
import { optionsOf, remoteHeaders } from "@rfetch/lib/options";
import { decodePath, encodePath } from "@rfetch/lib/path";
import { nanosecondsOf } from "@rfetch/lib/time";

/**
 * The options of the backend, with their types, for example for the flag
 * `--union-create-policy` of the command line.
 */
export const options = {
  string: [
    "upstreams",
    "action_policy",
    "create_policy",
    "search_policy",
    "cache_time",
    "min_free_space",
  ],
};

/**
 * An upstream of the union, as `upstream.Fs` of rclone.
 * @typedef {Object} Upstream
 * @property {string} remote The remote, with no tag.
 * @property {boolean} writable Union can change and delete its files.
 * @property {boolean} creatable Union can put new files and folders in it.
 * @property {boolean} writeback It is the cache of the other upstreams.
 */

/**
 * A policy of rclone. `ep` tells that a new path goes only to the upstreams
 * that have its folder. `pick` chooses among the upstreams: all of them, the
 * first one, one at random, or the one with the newest time.
 * @typedef {{ ep: boolean, pick: "all" | "first" | "random" | "newest" }} Policy
 */

/** @type {Record<string, Policy>} */
const POLICIES = {
  all: { ep: false, pick: "all" },
  epall: { ep: true, pick: "all" },
  epff: { ep: true, pick: "first" },
  eplfs: { ep: true, pick: "first" },
  eplno: { ep: true, pick: "first" },
  eplus: { ep: true, pick: "first" },
  epmfs: { ep: true, pick: "first" },
  eprand: { ep: true, pick: "random" },
  ff: { ep: false, pick: "first" },
  lfs: { ep: false, pick: "first" },
  lno: { ep: false, pick: "first" },
  lus: { ep: false, pick: "first" },
  mfs: { ep: false, pick: "first" },
  newest: { ep: true, pick: "newest" },
  rand: { ep: false, pick: "random" },
};

/** The tags at the end of an upstream, as rclone. */
const TAGS = [":ro", ":nc", ":writeback"];

/** The headers of a body, and the range: not for a request with no body. */
const BODY_HEADERS = [
  "Content-Encoding",
  "Content-Length",
  "Content-Type",
  "Range",
  "Transfer-Encoding",
];

/**
 * The upstreams and the policies of a union, as rclone.
 * @typedef {Object} Union
 * @property {Upstream[]} upstreams
 * @property {Policy} action
 * @property {Policy} create
 * @property {Policy} search
 */

/**
 * Reads the options of a union, as `NewFs` of rclone.
 * @param {URLSearchParams} options
 * @returns {Union}
 * @throws {Error} With the message of rclone, when an option is not correct.
 */
export function unionOf(options) {
  let values = parseList(options.get("upstreams") ?? "", " ");
  // The old option `remotes`: all but the last are read only.
  const remotes = parseList(options.get("remotes") ?? "", " ");
  if (values.length === 0 && remotes.length > 0) {
    values = remotes.map((remote, index) =>
      index < remotes.length - 1 ? `${remote}:ro` : remote
    );
  }
  if (values.length === 0) {
    throw new Error(
      "union can't point to an empty upstream - check the value of the upstreams setting",
    );
  }
  if (values.length === 1) {
    throw new Error(
      "union can't point to a single upstream - check the value of the upstreams setting",
    );
  }
  const upstreams = values.map(upstreamOf);
  const writebacks = upstreams.filter(({ writeback }) => writeback).length;
  if (writebacks > 1) {
    throw new Error(`can only have 1 :writeback not ${writebacks}`);
  }
  return {
    upstreams,
    action: policyOf(options.get("action_policy") || "epall"),
    create: policyOf(options.get("create_policy") || "epmfs"),
    search: policyOf(options.get("search_policy") || "ff"),
  };
}

/**
 * Reads an upstream and its tag, as `upstream.New` of rclone: the tag is at
 * the end of the path in the remote.
 * @param {string} value For example `remote:path:ro`.
 * @returns {Upstream}
 */
function upstreamOf(value) {
  const { path } = parse(value);
  const tag = TAGS.find((tag) => path.endsWith(tag));
  return {
    remote: tag ? value.slice(0, -tag.length) : value,
    writable: tag !== ":ro",
    creatable: tag !== ":ro" && tag !== ":nc",
    writeback: tag === ":writeback",
  };
}

/**
 * @param {string} name The name of a policy, in any case.
 * @returns {Policy}
 */
function policyOf(name) {
  const key = name.toLowerCase();
  if (!Object.hasOwn(POLICIES, key)) {
    throw new Error(`didn't find policy called ${JSON.stringify(name)}`);
  }
  return POLICIES[key];
}

/**
 * An upstream that has a path, with the answer to a `HEAD` of the path.
 * @typedef {{ upstream: Upstream, response: Response }} Found
 */

/**
 * Chooses among upstreams with a policy.
 * @template {{ time?: bigint }} T
 * @param {Policy} policy
 * @param {T[]} candidates In the order of the upstreams, with the time of
 *   the path in each one, in nanoseconds.
 * @returns {T[]}
 */
function pick(policy, candidates) {
  switch (policy.pick) {
    case "all":
      return candidates;
    case "random":
      return [candidates[Math.floor(Math.random() * candidates.length)]];
    case "newest": {
      // As rclone, the first one wins when the times are the same.
      let newest = candidates[0];
      for (const candidate of candidates) {
        if ((candidate.time ?? 0n) > (newest.time ?? 0n)) newest = candidate;
      }
      return [newest];
    }
    default:
      return candidates.slice(0, 1);
  }
}

/** The time of an answer, from its `Last-Modified`, in nanoseconds. */
function timeOf(/** @type {Response} */ response) {
  return nanosecondsOf(response.headers.get("Last-Modified")) ?? 0n;
}

/** One second, in nanoseconds. */
const SECOND = 1_000_000_000n;

/**
 * The folder of a path.
 * @param {string} path For example `/a/b.txt` or `/a/b/`.
 * @returns {string} For example `/a/`, `/` for a path in the root, or ""
 *   for the root.
 */
export function parentOf(path) {
  if (path === "/") return "";
  const end = path.endsWith("/") ? path.length - 1 : path.length;
  return path.slice(0, path.lastIndexOf("/", end - 1) + 1);
}

/**
 * Sends the requests of a union to its upstreams with the global `fetch`.
 * @param {Request} request
 * @param {Record<string, unknown>} [env] The options in the variables
 *   `RFETCH_UNION_*` or `RCLONE_UNION_*`.
 * @returns {Promise<Response>}
 */
async function union(request, env = {}) {
  const { method } = request;
  const { pathname, searchParams } = new URL(request.url);

  /** @type {Union} */
  let config;
  try {
    config = unionOf(optionsOf(request, "union", env));
  } catch (error) {
    await request.body?.cancel();
    return new Response(/** @type {Error} */ (error).message, { status: 400 });
  }
  const path = decodePath(pathname);
  if (path === null) {
    await request.body?.cancel();
    return new Response(null, { status: 400 });
  }

  // The headers for a request with no body to an upstream.
  const plain = new Headers(request.headers);
  for (const name of BODY_HEADERS) plain.delete(name);

  /**
   * Sends a request to the path in an upstream, with the headers of the
   * request of the union by default.
   * @param {Upstream} upstream
   * @param {string} path
   * @param {RequestInit} [init]
   */
  const send = (upstream, path, init = {}) => {
    const { remote } = upstream;
    const headers = remoteHeaders(
      init.headers ?? request.headers,
      "union",
      remote,
    );
    return fetch(remote.replace(/\/$/, "") + encodePath(path), {
      ...init,
      headers,
    });
  };

  /**
   * The upstreams that have a path, in their order.
   * @param {string} path
   * @param {Upstream[]} [upstreams]
   * @returns {Promise<Found[] | Response>} An answer for an error that is
   *   not 404.
   */
  const find = async (path, upstreams = config.upstreams) => {
    const responses = await Promise.all(
      upstreams.map((upstream) =>
        send(upstream, path, { method: "HEAD", headers: plain })
      ),
    );
    for (const response of responses) await response.body?.cancel();
    const failed = responses.find(({ ok, status }) => !ok && status !== 404);
    if (failed) {
      return new Response(null, {
        status: failed.status,
        statusText: failed.statusText,
      });
    }
    return responses.flatMap((response, index) =>
      response.ok ? [{ upstream: upstreams[index], response }] : []
    );
  };

  /**
   * The upstreams that have a path, with the time of the path in each one.
   * `Last-Modified` has whole seconds, but rclone compares the times to the
   * nanosecond. Thus for the policy `newest`, when more than one upstream
   * has the newest second, the lists of the folder of the path give the
   * times. When a list does not give a time in that second, the times stay
   * the same, and the first upstream wins, as for two equal times.
   * @param {Policy} policy
   * @param {string} path
   * @param {Found[]} found
   * @returns {Promise<Array<Found & { time: bigint }>>}
   */
  const timed = async (policy, path, found) => {
    const candidates = found.map((item) => ({
      ...item,
      time: timeOf(item.response),
    }));
    const folder = parentOf(path);
    if (policy.pick !== "newest" || folder === "") return candidates;
    const newest = candidates.reduce(
      (time, candidate) => candidate.time > time ? candidate.time : time,
      0n,
    );
    const same = candidates.filter(({ time }) => time === newest);
    if (same.length < 2) return candidates;
    const name = path.slice(folder.length).replace(/\/$/, "");
    const times = await Promise.all(same.map(async ({ upstream }) => {
      const response = await send(upstream, folder, { headers: plain });
      if (!response.ok) {
        await response.body?.cancel();
        return undefined;
      }
      const entries = await readListing(
        response,
        new URL("http://remote/folder/"),
      );
      const entry = entries.find((entry) => entry.Name === name);
      const time = nanosecondsOf(entry?.ModTime);
      return time !== undefined && time / SECOND === newest / SECOND
        ? time
        : undefined;
    }));
    if (times.includes(undefined)) return candidates;
    same.forEach((candidate, index) => {
      candidate.time = /** @type {bigint} */ (times[index]);
    });
    return candidates;
  };

  /**
   * The upstreams for a new path, as the create policy of rclone. A policy
   * `ep` uses the upstreams that have the deepest folder of the path. When
   * no upstream has a folder of the path, it uses all the upstreams.
   * @param {string} path
   * @returns {Promise<Upstream[] | Response>}
   */
  const creating = async (path) => {
    const creatable = config.upstreams.filter(({ creatable }) => creatable);
    if (creatable.length === 0) {
      return new Response("permission denied", { status: 403 });
    }
    const { create } = config;
    if (create.ep) {
      for (
        let folder = parentOf(path);
        folder !== "";
        folder = parentOf(folder)
      ) {
        const found = await find(folder, creatable);
        if (found instanceof Response) return found;
        if (found.length > 0) {
          const candidates = await timed(create, folder, found);
          return pick(create, candidates).map(({ upstream }) => upstream);
        }
      }
    }
    return pick(create, creatable.map((upstream) => ({ upstream }))).map((
      { upstream },
    ) => upstream);
  };

  if (method === "GET" || method === "HEAD") {
    if (path.endsWith("/") && method === "GET") {
      return await list(config, path, plain, send, `${searchParams}`);
    }
    const found = await find(path);
    if (found instanceof Response) return found;
    if (found.length === 0) {
      return new Response(
        path.endsWith("/") ? "directory not found" : "object not found",
        { status: 404 },
      );
    }
    const [chosen] = pick(
      config.search,
      await timed(config.search, path, found),
    );
    if (method === "HEAD") {
      // A folder of union has no body and no size.
      if (path.endsWith("/")) {
        return new Response(null, {
          headers: { "Content-Type": "text/html;charset=utf-8" },
        });
      }
      return chosen.response;
    }
    const writeback = config.upstreams.find(({ writeback }) => writeback);
    if (writeback && chosen.upstream !== writeback) {
      // As rclone, the read copies the file into the upstream of the cache,
      // then reads that copy.
      const source = await send(chosen.upstream, path, { headers: plain });
      if (!source.ok) return source;
      const headers = new Headers(plain);
      for (const name of ["Content-Length", "Content-Type"]) {
        const value = source.headers.get(name);
        if (value !== null) headers.set(name, value);
      }
      const copy = await send(writeback, path, {
        method: "PUT",
        body: source.body,
        duplex: "half",
        headers,
      });
      await copy.body?.cancel();
      if (!copy.ok) return copy;
      return await send(writeback, path);
    }
    return await send(chosen.upstream, path);
  }

  if (method === "PUT") {
    /** @type {Upstream[]} */
    let targets;
    // As Mkdir of rclone, a folder always goes to the upstreams of the
    // create policy.
    const found = path.endsWith("/") ? [] : await find(path);
    if (found instanceof Response) {
      await request.body?.cancel();
      return found;
    }
    const writable = found.filter(({ upstream }) => upstream.writable);
    if (writable.length > 0) {
      // A change of a path that exists, as the action policy of rclone.
      targets = pick(
        config.action,
        await timed(config.action, path, writable),
      ).map(({ upstream }) => upstream);
    } else {
      // A new path, or a file that is only in upstreams that union only
      // reads: as rclone, the file goes to the upstreams for a new path.
      const created = await creating(path);
      if (created instanceof Response) {
        await request.body?.cancel();
        return created;
      }
      targets = created;
    }
    const bodies = split(request.body, targets.length);
    const responses = await Promise.all(
      targets.map((upstream, index) =>
        send(upstream, path, {
          method: "PUT",
          body: bodies[index],
          duplex: "half",
        })
      ),
    );
    const failed = responses.find(({ ok }) => !ok);
    for (const response of responses) {
      if (response !== failed) await response.body?.cancel();
    }
    if (failed) return failed;
    return new Response(null, {
      status: 201,
      headers: { "Content-Location": pathname },
    });
  }

  if (method === "DELETE") {
    const found = await find(path);
    if (found instanceof Response) return found;
    if (found.length === 0) {
      return new Response(
        path.endsWith("/") ? "directory not found" : "object not found",
        { status: 404 },
      );
    }
    const writable = found.filter(({ upstream }) => upstream.writable);
    if (writable.length === 0) {
      return new Response("permission denied", { status: 403 });
    }
    const targets = pick(
      config.action,
      await timed(config.action, path, writable),
    );
    const responses = await Promise.all(
      targets.map(({ upstream }) =>
        send(upstream, path, { method: "DELETE", headers: plain })
      ),
    );
    const failed = responses.find(({ ok, status }) => !ok && status !== 404);
    for (const response of responses) {
      if (response !== failed) await response.body?.cancel();
    }
    return failed ?? new Response(null, { status: 204 });
  }

  await request.body?.cancel();
  return new Response(null, {
    status: 405,
    headers: { Allow: "GET, HEAD, PUT, DELETE" },
  });
}

/**
 * Gives a body to each upload, from one body.
 * @param {ReadableStream<Uint8Array> | null} body
 * @param {number} count
 * @returns {Array<ReadableStream<Uint8Array> | null>}
 */
function split(body, count) {
  if (body === null || count === 1) return Array(count).fill(body);
  /** @type {ReadableStream<Uint8Array>[]} */
  const bodies = [];
  let rest = body;
  for (let index = 1; index < count; index++) {
    const [one, other] = rest.tee();
    bodies.push(one);
    rest = other;
  }
  bodies.push(rest);
  return bodies;
}

/**
 * The list of a folder: the entries of the folder in each upstream, as
 * `List` of rclone. For a name in more than one upstream, the search policy
 * chooses the entry. A folder has the newest time of its upstreams.
 * @param {Union} config
 * @param {string} path The folder, with a `/` at the end.
 * @param {Headers} headers The headers of the requests to the upstreams.
 * @param {(upstream: Upstream, path: string, init?: RequestInit) => Promise<Response>} send
 * @param {string} query The query of the links of the list.
 * @returns {Promise<Response>}
 */
async function list(config, path, headers, send, query) {
  const base = new URL("http://remote/folder/");
  const lists = await Promise.all(
    config.upstreams.map(async (upstream) => {
      const response = await send(upstream, path, { headers });
      if (!response.ok) return response;
      return await readListing(response, base);
    }),
  );
  const errors = lists.filter((item) => item instanceof Response);
  // As rclone, union lists the folder when one upstream or more can.
  const failed = errors.length === lists.length
    ? errors.find(({ status }) => status !== 404)
    : undefined;
  for (const response of errors) {
    if (response !== failed) await response.body?.cancel();
  }
  if (errors.length === lists.length) {
    return failed ?? new Response("directory not found", { status: 404 });
  }

  /** @type {Map<string, Array<import("@rfetch/lib/listing").Entry & { time: bigint }>>} */
  const names = new Map();
  for (const entries of lists) {
    if (entries instanceof Response) continue;
    for (const entry of entries) {
      const item = { ...entry, time: nanosecondsOf(entry.ModTime) ?? 0n };
      const same = names.get(entry.Name);
      if (same) same.push(item);
      else names.set(entry.Name, [item]);
    }
  }
  const merged = [...names.values()].map((candidates) => {
    const [{ time: _, ...entry }] = pick(config.search, candidates);
    if (!entry.IsDir) return entry;
    // A folder has the newest time of its upstreams, and no size.
    const newest = candidates.reduce((a, b) => b.time > a.time ? b : a);
    return { ...entry, Size: -1, ModTime: newest.ModTime };
  });
  return new Response(renderListing(merged, { query }), {
    headers: { "Content-Type": "text/html;charset=utf-8" },
  });
}

export default {
  fetch: union,
};
