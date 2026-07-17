import { ArchiveFormatError } from "./errors";

const MAX_LZ4_OUTPUT_BYTES = 512 * 1024 * 1024;

export function inflateArqLz4(input: Uint8Array): Uint8Array {
  if (input.byteLength < 5) {
    throw new ArchiveFormatError("invalid_lz4", "LZ4 data is too short");
  }

  const expectedSize = new DataView(input.buffer, input.byteOffset, 4).getUint32(0, false);
  if (expectedSize > MAX_LZ4_OUTPUT_BYTES) {
    throw new ArchiveFormatError("lz4_output_too_large", "LZ4 data declares more than 512 MiB of output");
  }
  const output = new Uint8Array(expectedSize);
  let sourceOffset = 4;
  let outputOffset = 0;

  while (sourceOffset < input.byteLength) {
    const token = input[sourceOffset++];
    if (token === undefined) throw invalidLz4();

    let literalLength = token >>> 4;
    if (literalLength === 15) {
      const extended = readExtendedLength(input, sourceOffset);
      literalLength += extended.length;
      sourceOffset = extended.nextOffset;
    }
    if (sourceOffset + literalLength > input.byteLength || outputOffset + literalLength > output.byteLength) {
      throw invalidLz4();
    }
    output.set(input.subarray(sourceOffset, sourceOffset + literalLength), outputOffset);
    sourceOffset += literalLength;
    outputOffset += literalLength;

    if (sourceOffset === input.byteLength) break;
    if (sourceOffset + 2 > input.byteLength) throw invalidLz4();
    const matchOffset = input[sourceOffset]! | (input[sourceOffset + 1]! << 8);
    sourceOffset += 2;
    if (matchOffset === 0 || matchOffset > outputOffset) throw invalidLz4();

    let matchLength = (token & 0x0f) + 4;
    if ((token & 0x0f) === 15) {
      const extended = readExtendedLength(input, sourceOffset);
      matchLength += extended.length;
      sourceOffset = extended.nextOffset;
    }
    if (outputOffset + matchLength > output.byteLength) throw invalidLz4();
    for (let index = 0; index < matchLength; index += 1) {
      output[outputOffset + index] = output[outputOffset - matchOffset + index]!;
    }
    outputOffset += matchLength;
  }

  if (outputOffset !== expectedSize) throw invalidLz4();
  return output;
}

function readExtendedLength(input: Uint8Array, initialOffset: number): { length: number; nextOffset: number } {
  let length = 0;
  let offset = initialOffset;
  while (true) {
    const value = input[offset++];
    if (value === undefined) throw invalidLz4();
    length += value;
    if (value !== 255) return { length, nextOffset: offset };
  }
}

function invalidLz4(): ArchiveFormatError {
  return new ArchiveFormatError("invalid_lz4", "LZ4 decompression failed");
}
