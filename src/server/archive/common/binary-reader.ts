import { ArchiveFormatError } from "./errors";

const MAX_COLLECTION_ITEMS = 10_000_000n;
const MAX_STRING_BYTES = 2_147_483_648n;

export class BinaryReader {
  readonly #bytes: Uint8Array;
  readonly #view: DataView;
  #offset = 0;

  constructor(bytes: Uint8Array, readonly description: string) {
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get offset(): number {
    return this.#offset;
  }

  get remaining(): number {
    return this.#bytes.byteLength - this.#offset;
  }

  readBytes(length: number): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.remaining) {
      throw new ArchiveFormatError(
        "unexpected_end_of_data",
        `${this.description} needs ${length} bytes at offset ${this.#offset}, but only ${this.remaining} remain`,
      );
    }
    const value = this.#bytes.subarray(this.#offset, this.#offset + length);
    this.#offset += length;
    return value;
  }

  readAscii(length: number): string {
    return String.fromCharCode(...this.readBytes(length));
  }

  readBoolean(): boolean {
    return this.readBytes(1)[0] !== 0;
  }

  readUint32(): number {
    this.#require(4);
    const value = this.#view.getUint32(this.#offset, false);
    this.#offset += 4;
    return value;
  }

  readInt32(): number {
    this.#require(4);
    const value = this.#view.getInt32(this.#offset, false);
    this.#offset += 4;
    return value;
  }

  readUint64(): bigint {
    this.#require(8);
    const value = this.#view.getBigUint64(this.#offset, false);
    this.#offset += 8;
    return value;
  }

  readInt64(): bigint {
    this.#require(8);
    const value = this.#view.getBigInt64(this.#offset, false);
    this.#offset += 8;
    return value;
  }

  readCount(label: string): number {
    const value = this.readUint64();
    if (value > MAX_COLLECTION_ITEMS || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new ArchiveFormatError("absurd_collection_size", `${this.description} has an invalid ${label} count`);
    }
    return Number(value);
  }

  readNullableString(): string | null {
    if (!this.readBoolean()) return null;
    const length = this.readUint64();
    if (length > MAX_STRING_BYTES || length > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new ArchiveFormatError("absurd_string_length", `${this.description} contains an invalid string length`);
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(this.readBytes(Number(length)));
    } catch (error) {
      if (error instanceof ArchiveFormatError) throw error;
      throw new ArchiveFormatError("invalid_utf8", `${this.description} contains an invalid UTF-8 string`);
    }
  }

  readString(label: string): string {
    const value = this.readNullableString();
    if (value === null) throw new ArchiveFormatError("missing_string", `${this.description} is missing ${label}`);
    return value;
  }

  readData(): Uint8Array {
    const length = this.readUint64();
    if (length > BigInt(this.remaining) || length > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new ArchiveFormatError("invalid_data_length", `${this.description} contains an invalid data length`);
    }
    return this.readBytes(Number(length));
  }

  readDate(): Date | null {
    if (!this.readBoolean()) return null;
    const milliseconds = this.readInt64();
    const asNumber = Number(milliseconds);
    if (!Number.isSafeInteger(asNumber)) {
      throw new ArchiveFormatError("invalid_date", `${this.description} contains an out-of-range date`);
    }
    const value = new Date(asNumber);
    if (Number.isNaN(value.getTime())) throw new ArchiveFormatError("invalid_date", `${this.description} contains an invalid date`);
    return value;
  }

  #require(length: number): void {
    if (this.remaining < length) {
      throw new ArchiveFormatError(
        "unexpected_end_of_data",
        `${this.description} ended at offset ${this.#offset}`,
      );
    }
  }
}
