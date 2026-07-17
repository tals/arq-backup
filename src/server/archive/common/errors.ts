export class ArchiveFormatError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ArchiveFormatError";
  }
}
