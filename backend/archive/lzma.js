/**
 * The decoders of LZMA and LZMA2, for the 7z format: no Web API reads
 * them. The code follows `LzmaSpec.cpp` and `Lzma2Dec.c` of the LZMA SDK
 * of Igor Pavlov, which are in the public domain.
 *
 * A decoder is a TransformStream: it reads the compressed bytes and gives
 * the bytes of the data. It decodes a symbol only when it has 20 bytes of
 * input or the end of the input, thus a symbol never waits for input.
 */
import { ArchiveError } from "./entry.js";

const PROBABILITY_BITS = 11;
const PROBABILITY_START = 1 << (PROBABILITY_BITS - 1);
const MOVE_BITS = 5;
const TOP = 2 ** 24;
const STATES = 12;
const POSITION_BITS_MAX = 4;
const LENGTH_TO_POSITION_STATES = 4;
const ALIGN_BITS = 4;
const END_POSITION_MODEL = 14;
const FULL_DISTANCES = 1 << (END_POSITION_MODEL >> 1);
const MATCH_MIN_LENGTH = 2;
/** The most input bytes that one symbol reads. */
const SYMBOL_INPUT = 20;
/** The largest dictionary that rfetch makes, in memory. */
export const MAX_DICTIONARY = 64 * 1024 * 1024;

const ERROR = "7z: the LZMA data are not correct";

/** The probabilities of a part of the model. @param {number} size */
function probabilities(size) {
  return new Uint16Array(size).fill(PROBABILITY_START);
}

/**
 * The state of a decoder of LZMA: the dictionary, the model and the range
 * decoder. LZMA2 changes its properties and resets it between chunks.
 */
class Lzma {
  /** @param {number} dictionarySize */
  constructor(dictionarySize) {
    if (dictionarySize > MAX_DICTIONARY) {
      throw new ArchiveError("7z: the LZMA dictionary is too large", 501);
    }
    this.size = Math.max(dictionarySize, 4096);
    this.window = new Uint8Array(this.size);
    this.position = 0;
    this.total = 0;
    this.full = false;
    // The range decoder.
    this.input = new Uint8Array(0);
    this.at = 0;
    this.range = 0;
    this.code = 0;
    this.lc = 3;
    this.lp = 0;
    this.pb = 2;
    // A match that the limit of the output stopped.
    this.pendingLength = 0;
    this.resetState();
  }

  /** @param {number} byte The byte of the properties: lc, lp and pb. */
  setProperties(byte) {
    if (byte >= 9 * 5 * 5) throw new ArchiveError(ERROR);
    this.lc = byte % 9;
    this.lp = Math.floor(byte / 9) % 5;
    this.pb = Math.floor(byte / 45);
  }

  resetDictionary() {
    this.position = 0;
    this.total = 0;
    this.full = false;
  }

  resetState() {
    this.literals = probabilities(0x300 << (this.lc + this.lp));
    this.isMatch = probabilities(STATES << POSITION_BITS_MAX);
    this.isRep = probabilities(STATES);
    this.isRepG0 = probabilities(STATES);
    this.isRepG1 = probabilities(STATES);
    this.isRepG2 = probabilities(STATES);
    this.isRep0Long = probabilities(STATES << POSITION_BITS_MAX);
    this.positionSlots = probabilities(LENGTH_TO_POSITION_STATES << 6);
    this.positions = probabilities(1 + FULL_DISTANCES - END_POSITION_MODEL);
    this.align = probabilities(1 << ALIGN_BITS);
    this.lengths = lengthModel();
    this.repLengths = lengthModel();
    this.state = 0;
    this.reps = [0, 0, 0, 0];
    this.pendingLength = 0;
  }

  /**
   * Starts the range decoder on bytes.
   * @param {Uint8Array} input
   * @param {number} at
   */
  startRange(input, at) {
    if (input.length - at < 5 || input[at] !== 0) throw new ArchiveError(ERROR);
    this.input = input;
    this.range = 0xffffffff;
    this.code = 0;
    for (let index = 1; index < 5; index++) {
      this.code = (this.code * 256 + input[at + index]) >>> 0;
    }
    this.at = at + 5;
    if (this.code === this.range) throw new ArchiveError(ERROR);
  }

  #normalize() {
    if (this.range < TOP) {
      this.range = (this.range * 256) >>> 0;
      this.code = (this.code * 256 + (this.input[this.at++] ?? 0)) >>> 0;
    }
  }

  /**
   * @param {Uint16Array} probs
   * @param {number} index
   */
  #bit(probs, index) {
    const probability = probs[index];
    const bound = (this.range >>> PROBABILITY_BITS) * probability;
    let bit;
    if (this.code < bound) {
      probs[index] = probability +
        (((1 << PROBABILITY_BITS) - probability) >>> MOVE_BITS);
      this.range = bound;
      bit = 0;
    } else {
      probs[index] = probability - (probability >>> MOVE_BITS);
      this.code -= bound;
      this.range -= bound;
      bit = 1;
    }
    this.#normalize();
    return bit;
  }

  /** @param {number} count */
  #directBits(count) {
    let result = 0;
    for (let index = 0; index < count; index++) {
      this.range >>>= 1;
      let bit = 0;
      if (this.code >= this.range) {
        this.code -= this.range;
        bit = 1;
      }
      this.#normalize();
      result = result * 2 + bit;
    }
    return result;
  }

  /**
   * @param {Uint16Array} probs
   * @param {number} offset
   * @param {number} bits
   */
  #tree(probs, offset, bits) {
    let value = 1;
    for (let index = 0; index < bits; index++) {
      value = (value << 1) + this.#bit(probs, offset + value);
    }
    return value - (1 << bits);
  }

  /**
   * @param {Uint16Array} probs
   * @param {number} offset
   * @param {number} bits
   */
  #reverseTree(probs, offset, bits) {
    let value = 1;
    let symbol = 0;
    for (let index = 0; index < bits; index++) {
      const bit = this.#bit(probs, offset + value);
      value = (value << 1) + bit;
      symbol |= bit << index;
    }
    return symbol;
  }

  /**
   * @param {ReturnType<typeof lengthModel>} model
   * @param {number} positionState
   */
  #length(model, positionState) {
    if (!this.#bit(model.choice, 0)) {
      return this.#tree(model.low, positionState << 3, 3);
    }
    if (!this.#bit(model.choice, 1)) {
      return 8 + this.#tree(model.mid, positionState << 3, 3);
    }
    return 16 + this.#tree(model.high, 0, 8);
  }

  /** @param {number} distance 1 for the last byte. */
  #byteAt(distance) {
    const index = this.position - distance;
    return this.window[index >= 0 ? index : index + this.size];
  }

  /** @param {number} byte */
  #put(byte) {
    this.window[this.position++] = byte;
    this.total++;
    if (this.position === this.size) {
      this.position = 0;
      this.full = true;
    }
  }

  /**
   * Puts the bytes of data that are not compressed in the dictionary, for
   * LZMA2.
   * @param {Uint8Array} bytes
   */
  putBytes(bytes) {
    for (const byte of bytes) this.#put(byte);
  }

  /** @param {number} length */
  #copy(length) {
    const distance = this.reps[0] + 1;
    for (let index = 0; index < length; index++) {
      this.#put(this.#byteAt(distance));
    }
  }

  /**
   * Decodes symbols until the output has `limit` bytes, the input has no
   * full symbol, or the data end.
   * @param {number} limit The most bytes to give.
   * @param {number} end The end of the input of this stream.
   * @param {boolean} finished There is no more input after `end`.
   * @param {number} remaining The bytes that the data still have, or -1
   *   when the size is not known.
   * @returns {{ count: number, done: boolean }} The bytes that the call
   *   gave, and true at the end of the data.
   */
  decode(limit, end, finished, remaining) {
    let count = 0;
    while (this.pendingLength > 0 && count < limit && remaining !== 0) {
      this.#copy(1);
      this.pendingLength--;
      count++;
      if (remaining > 0) remaining--;
    }
    while (count < limit) {
      if (remaining === 0) return { count, done: true };
      if (!finished && end - this.at < SYMBOL_INPUT) {
        return { count, done: false };
      }
      if (this.at > end + 4) throw new ArchiveError(ERROR);
      const positionState = this.total & ((1 << this.pb) - 1);
      const state = this.state;
      if (
        !this.#bit(this.isMatch, (state << POSITION_BITS_MAX) + positionState)
      ) {
        this.#literal();
        this.state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
        count++;
        if (remaining > 0) remaining--;
        continue;
      }
      let length;
      if (this.#bit(this.isRep, state)) {
        if (this.total === 0) throw new ArchiveError(ERROR);
        if (!this.#bit(this.isRepG0, state)) {
          if (
            !this.#bit(
              this.isRep0Long,
              (state << POSITION_BITS_MAX) + positionState,
            )
          ) {
            this.state = state < 7 ? 9 : 11;
            this.#put(this.#byteAt(this.reps[0] + 1));
            count++;
            if (remaining > 0) remaining--;
            continue;
          }
        } else {
          let distance;
          if (!this.#bit(this.isRepG1, state)) {
            distance = this.reps[1];
          } else {
            if (!this.#bit(this.isRepG2, state)) {
              distance = this.reps[2];
            } else {
              distance = this.reps[3];
              this.reps[3] = this.reps[2];
            }
            this.reps[2] = this.reps[1];
          }
          this.reps[1] = this.reps[0];
          this.reps[0] = distance;
        }
        length = this.#length(this.repLengths, positionState);
        this.state = state < 7 ? 8 : 11;
      } else {
        this.reps[3] = this.reps[2];
        this.reps[2] = this.reps[1];
        this.reps[1] = this.reps[0];
        length = this.#length(this.lengths, positionState);
        this.state = state < 7 ? 7 : 10;
        const distance = this.#distance(length);
        if (distance === 0xffffffff) {
          // The end marker.
          return { count, done: true };
        }
        this.reps[0] = distance;
        if (
          distance >= this.size || (!this.full && distance >= this.position)
        ) {
          throw new ArchiveError(ERROR);
        }
      }
      length += MATCH_MIN_LENGTH;
      if (remaining >= 0 && length > remaining) throw new ArchiveError(ERROR);
      const now = Math.min(length, limit - count);
      this.#copy(now);
      this.pendingLength = length - now;
      count += now;
      if (remaining > 0) remaining -= now;
    }
    return { count, done: remaining === 0 };
  }

  #literal() {
    const previous = this.total === 0 ? 0 : this.#byteAt(1);
    const literalState = ((this.total & ((1 << this.lp) - 1)) << this.lc) +
      (previous >> (8 - this.lc));
    const offset = 0x300 * literalState;
    let symbol = 1;
    if (this.state >= 7) {
      let match = this.#byteAt(this.reps[0] + 1);
      do {
        const matchBit = (match >> 7) & 1;
        match <<= 1;
        const bit = this.#bit(
          this.literals,
          offset + ((1 + matchBit) << 8) + symbol,
        );
        symbol = (symbol << 1) | bit;
        if (matchBit !== bit) break;
      } while (symbol < 0x100);
    }
    while (symbol < 0x100) {
      symbol = (symbol << 1) | this.#bit(this.literals, offset + symbol);
    }
    this.#put(symbol - 0x100);
  }

  /** @param {number} length */
  #distance(length) {
    const lengthState = Math.min(length, LENGTH_TO_POSITION_STATES - 1);
    const slot = this.#tree(this.positionSlots, lengthState << 6, 6);
    if (slot < 4) return slot;
    const directBits = (slot >> 1) - 1;
    let distance = ((2 | (slot & 1)) << directBits) >>> 0;
    if (slot < END_POSITION_MODEL) {
      return distance +
        this.#reverseTree(this.positions, distance - slot, directBits);
    }
    distance += this.#directBits(directBits - ALIGN_BITS) * (1 << ALIGN_BITS);
    distance += this.#reverseTree(this.align, 0, ALIGN_BITS);
    return distance >>> 0;
  }

  /**
   * The last `count` bytes of the dictionary.
   * @param {number} count
   */
  last(count) {
    const out = new Uint8Array(count);
    let start = this.position - count;
    if (start >= 0) {
      out.set(this.window.subarray(start, this.position));
    } else {
      start += this.size;
      out.set(this.window.subarray(start));
      out.set(this.window.subarray(0, this.position), this.size - start);
    }
    return out;
  }
}

/** The model of the lengths. */
function lengthModel() {
  return {
    choice: probabilities(2),
    low: probabilities(1 << (POSITION_BITS_MAX + 3)),
    mid: probabilities(1 << (POSITION_BITS_MAX + 3)),
    high: probabilities(1 << 8),
  };
}

/** The bytes of the output of one call, at most. */
const OUTPUT = 64 * 1024;

/**
 * Joins two arrays of bytes.
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 */
function join(a, b) {
  if (a.length === 0) return b;
  const all = new Uint8Array(a.length + b.length);
  all.set(a);
  all.set(b, a.length);
  return all;
}

/**
 * A stream that decodes LZMA, as the coder 030101 of 7z.
 * @param {Uint8Array} properties The 5 bytes of the coder: lc, lp and pb,
 *   then the size of the dictionary.
 * @param {number} size The size of the data, or -1 when it is not known.
 * @returns {TransformStream<Uint8Array, Uint8Array>}
 */
export function lzmaStream(properties, size) {
  if (properties.length < 5) throw new ArchiveError(ERROR);
  const dictionary = new DataView(
    properties.buffer,
    properties.byteOffset + 1,
    4,
  ).getUint32(0, true);
  const lzma = new Lzma(
    size >= 0 ? Math.min(dictionary, Math.max(size, 4096)) : dictionary,
  );
  lzma.setProperties(properties[0]);
  lzma.resetState();
  let input = new Uint8Array(0);
  let started = false;
  let remaining = size;
  let done = false;
  const limit = Math.min(OUTPUT, lzma.size - 273);

  /**
   * @param {TransformStreamDefaultController<Uint8Array>} controller
   * @param {boolean} finished
   */
  const run = (controller, finished) => {
    if (!started) {
      if (input.length < 5 && !finished) return;
      lzma.startRange(input, 0);
      started = true;
    }
    lzma.input = input;
    while (!done) {
      const result = lzma.decode(limit, input.length, finished, remaining);
      if (result.count > 0) controller.enqueue(lzma.last(result.count));
      if (remaining > 0) remaining -= result.count;
      if (result.done) done = true;
      if (result.count === 0) break;
    }
    // Keeps the input that the decoder has not read.
    input = input.subarray(lzma.at);
    lzma.at = 0;
  };

  return new TransformStream({
    transform(chunk, controller) {
      if (done) return;
      input = join(input, chunk);
      lzma.input = input;
      run(controller, false);
    },
    flush(controller) {
      if (!done) run(controller, true);
      if (remaining > 0) throw new ArchiveError("7z: unexpected end of file");
    },
  });
}

/**
 * The size of the dictionary of LZMA2, from the byte of the coder.
 * @param {number} byte
 */
export function lzma2Dictionary(byte) {
  if (byte > 40) throw new ArchiveError(ERROR);
  if (byte === 40) return 0xffffffff;
  return (2 | (byte & 1)) * 2 ** (Math.floor(byte / 2) + 11);
}

/**
 * A stream that decodes LZMA2, as the coder 21 of 7z. LZMA2 is chunks of
 * at most 64 KiB of input: each chunk is LZMA or data with no
 * compression, with the resets of the dictionary and of the state.
 * @param {Uint8Array} properties The byte of the size of the dictionary.
 * @param {number} size The size of the data, or -1 when it is not known.
 * @returns {TransformStream<Uint8Array, Uint8Array>}
 */
export function lzma2Stream(properties, size) {
  const dictionary = lzma2Dictionary(properties[0] ?? 0);
  const lzma = new Lzma(
    size >= 0 ? Math.min(dictionary, Math.max(size, 4096)) : dictionary,
  );
  const limit = Math.min(OUTPUT, lzma.size - 273);
  let input = new Uint8Array(0);
  let done = false;
  /** The first chunk resets the dictionary and the properties. */
  let needed = 0xe0;

  /** @param {TransformStreamDefaultController<Uint8Array>} controller */
  const run = (controller) => {
    while (!done && input.length > 0) {
      const control = input[0];
      if (control === 0) {
        done = true;
        return;
      }
      if (control === 1 || control === 2) {
        // Data with no compression.
        if (control === 2 && needed === 0xe0) throw new ArchiveError(ERROR);
        if (input.length < 3) return;
        const length = (input[1] << 8 | input[2]) + 1;
        if (input.length < 3 + length) return;
        if (control === 1) {
          lzma.resetDictionary();
          needed = 0xc0;
        }
        const data = input.subarray(3, 3 + length);
        lzma.putBytes(data);
        controller.enqueue(data.slice());
        input = input.subarray(3 + length);
        continue;
      }
      if (control < 0x80 || control < needed) throw new ArchiveError(ERROR);
      const mode = (control >> 5) & 3;
      const header = mode >= 2 ? 6 : 5;
      if (input.length < header) return;
      const unpacked = ((control & 0x1f) << 16 | input[1] << 8 | input[2]) + 1;
      const packed = (input[3] << 8 | input[4]) + 1;
      if (input.length < header + packed) return;
      if (mode === 3) lzma.resetDictionary();
      if (mode >= 2) {
        const byte = input[5];
        lzma.setProperties(byte);
        if (lzma.lc + lzma.lp > 4) throw new ArchiveError(ERROR);
      }
      if (mode >= 1) lzma.resetState();
      needed = 0;
      // The chunk is all in the input: the decoder reads it at once.
      const chunk = input.slice(header, header + packed);
      lzma.startRange(chunk, 0);
      let left = unpacked;
      while (left > 0) {
        const result = lzma.decode(
          Math.min(limit, left),
          chunk.length,
          true,
          left,
        );
        if (result.count === 0) throw new ArchiveError(ERROR);
        controller.enqueue(lzma.last(result.count));
        left -= result.count;
      }
      input = input.subarray(header + packed);
    }
  };

  let count = 0;
  return new TransformStream({
    transform(chunk, controller) {
      if (done) return;
      input = join(input, chunk);
      run({
        enqueue(bytes) {
          count += bytes.length;
          controller.enqueue(bytes);
        },
      });
    },
    flush() {
      if (size >= 0 && count < size) {
        throw new ArchiveError("7z: unexpected end of file");
      }
    },
  });
}
