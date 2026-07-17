import type { ArchiveEntrySummary } from "../../shared/contracts";

export type RestoreItemDescriptor = {
  entry: ArchiveEntrySummary;
  identity: string;
  modifiedSeconds: number;
  modifiedNanoseconds: number;
};

export interface RestoreSource {
  getEntry(token: string): ArchiveEntrySummary;
  restoreIdentity(token: string): string;
  describeRestoreItem(token: string): RestoreItemDescriptor;
  listChildren(token: string): Promise<ArchiveEntrySummary[]>;
  readData(token: string): AsyncIterable<Uint8Array>;
}
