import type { CloudBucket } from "../../shared/contracts";

export type CloudObject = {
  id: string | null;
  name: string;
  kind: "file" | "folder";
  size: number;
  uploadedAt: Date | null;
};

export type ObjectPage = {
  objects: CloudObject[];
  nextCursor: string | null;
};

export type ListObjectOptions = {
  prefix?: string;
  delimiter?: string;
  cursor?: string;
  limit?: number;
};

export type ReadObjectOptions = {
  range?: { start: number; endInclusive?: number };
  signal?: AbortSignal;
};

export interface CloudStorageProvider {
  readonly connectionId: number;
  readonly connectionLabel: string;
  readonly kind: "b2";

  listBuckets(): Promise<CloudBucket[]>;
  listObjects(bucket: CloudBucket, options?: ListObjectOptions): Promise<ObjectPage>;
  readObject(bucket: CloudBucket, objectName: string, options?: ReadObjectOptions): Promise<Uint8Array>;
}

export class CloudProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "CloudProviderError";
  }
}
