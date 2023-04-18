/**
 * A TransformStream that slices into chunks of a given size.
 */
export class Chunker extends TransformStream<Uint8Array, Uint8Array> {
  constructor(chunkSize: number) {
    let partialChunk = new Uint8Array(chunkSize);
    let offset = 0;

    function transform(
      chunk: Uint8Array,
      controller: TransformStreamDefaultController,
    ) {
      let i = 0;

      if (offset > 0) {
        const len = Math.min(chunk.byteLength, chunkSize - offset);
        partialChunk.set(chunk.slice(0, len), offset);
        offset += len;
        i += len;

        if (offset === chunkSize) {
          controller.enqueue(partialChunk);
          partialChunk = new Uint8Array(chunkSize);
          offset = 0;
        }
      }

      while (i < chunk.byteLength) {
        const remainingBytes = chunk.byteLength - i;
        if (remainingBytes >= chunkSize) {
          const record = chunk.slice(i, i + chunkSize);
          i += chunkSize;
          controller.enqueue(record);
          partialChunk = new Uint8Array(chunkSize);
          offset = 0;
        } else {
          const end = chunk.slice(i, i + remainingBytes);
          i += end.byteLength;
          partialChunk.set(end);
          offset = end.byteLength;
        }
      }
    }

    function flush(controller: TransformStreamDefaultController) {
      if (offset > 0) {
        controller.enqueue(partialChunk.slice(0, offset));
      }
    }

    super({
      transform,
      flush,
    });
  }
}
