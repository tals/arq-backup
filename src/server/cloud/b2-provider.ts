import type { CloudBucket } from "../../shared/contracts";
import type { B2Credential } from "../credentials/credential-repository";
import {
  CloudProviderError,
  type CloudObject,
  type CloudStorageProvider,
  type ListObjectOptions,
  type ObjectPage,
  type ReadObjectOptions,
} from "./provider";

const AUTHORIZE_URL = "https://api.backblazeb2.com/b2api/v4/b2_authorize_account";

type B2Allowed = {
  capabilities: string[];
  bucketId?: string | null;
  bucketName?: string | null;
  namePrefix?: string | null;
};

type B2Authorization = {
  accountId: string;
  authorizationToken: string;
  apiUrl: string;
  downloadUrl: string;
  allowed: B2Allowed;
};

type B2AuthorizePayload = {
  accountId: string;
  authorizationToken?: string;
  apiInfo?: {
    storageApi?: {
      apiUrl: string;
      downloadUrl: string;
      allowed: B2Allowed;
      authorizationToken?: string;
    };
  };
  apiUrl?: string;
  downloadUrl?: string;
  allowed?: B2Allowed;
};

type B2BucketPayload = {
  bucketId: string;
  bucketName: string;
};

type B2FilePayload = {
  action: string;
  contentLength: number;
  fileId?: string | null;
  fileName: string;
  uploadTimestamp?: number;
};

type B2ErrorPayload = {
  code?: string;
  message?: string;
  status?: number;
};

export class B2Provider implements CloudStorageProvider {
  readonly kind = "b2" as const;
  readonly connectionId: number;
  readonly connectionLabel: string;

  readonly #applicationKeyId: string;
  readonly #applicationKey: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #authorizeUrl: string;
  #authorization: B2Authorization | null = null;

  constructor(
    credential: B2Credential,
    options: { fetch?: typeof globalThis.fetch; authorizeUrl?: string } = {},
  ) {
    this.connectionId = credential.id;
    this.connectionLabel = credential.label;
    this.#applicationKeyId = credential.applicationKeyId;
    this.#applicationKey = credential.applicationKey;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#authorizeUrl = options.authorizeUrl ?? AUTHORIZE_URL;
  }

  async listBuckets(): Promise<CloudBucket[]> {
    const auth = await this.#authorize();
    const restrictedBucketId = auth.allowed.bucketId ?? null;
    const restrictedBucketName = auth.allowed.bucketName ?? null;

    if (!auth.allowed.capabilities.includes("listBuckets") && restrictedBucketId && restrictedBucketName) {
      return [this.#toBucket({ bucketId: restrictedBucketId, bucketName: restrictedBucketName })];
    }

    const params = new URLSearchParams({ accountId: auth.accountId });
    if (restrictedBucketId) params.set("bucketId", restrictedBucketId);
    else if (restrictedBucketName) params.set("bucketName", restrictedBucketName);

    const payload = await this.#apiRequest<{ buckets: B2BucketPayload[] }>(
      `${auth.apiUrl}/b2api/v4/b2_list_buckets?${params}`,
      auth,
    );
    return payload.buckets.map(bucket => this.#toBucket(bucket)).sort((a, b) => a.name.localeCompare(b.name));
  }

  async listObjects(bucket: CloudBucket, options: ListObjectOptions = {}): Promise<ObjectPage> {
    this.#assertBucket(bucket);
    const auth = await this.#authorize();
    const requestBody: Record<string, unknown> = {
      bucketId: bucket.id,
      maxFileCount: Math.min(Math.max(options.limit ?? 1_000, 1), 10_000),
    };
    if (options.prefix !== undefined) requestBody.prefix = options.prefix;
    if (options.delimiter !== undefined) requestBody.delimiter = options.delimiter;
    if (options.cursor) requestBody.startFileName = options.cursor;

    const payload = await this.#apiRequest<{ files: B2FilePayload[]; nextFileName?: string | null }>(
      `${auth.apiUrl}/b2api/v4/b2_list_file_names`,
      auth,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      },
    );

    return {
      objects: payload.files.map(file => this.#toObject(file)),
      nextCursor: payload.nextFileName ?? null,
    };
  }

  async readObject(
    bucket: CloudBucket,
    objectName: string,
    options: ReadObjectOptions = {},
  ): Promise<Uint8Array> {
    this.#assertBucket(bucket);
    const encodedName = objectName.split("/").map(encodeURIComponent).join("/");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const auth = await this.#authorize();
      const headers = new Headers({ Authorization: auth.authorizationToken });
      if (options.range) {
        const end = options.range.endInclusive === undefined ? "" : String(options.range.endInclusive);
        headers.set("Range", `bytes=${options.range.start}-${end}`);
      }

      const response = await this.#fetch(`${auth.downloadUrl}/file/${encodeURIComponent(bucket.name)}/${encodedName}`, {
        headers,
        signal: options.signal,
      });
      if (response.ok) return new Uint8Array(await response.arrayBuffer());
      if (response.status === 401) {
        if (this.#authorization === auth) this.#authorization = null;
        if (attempt === 0) continue;
      }
      await this.#throwResponseError(response);
    }
    throw new CloudProviderError("download_retry_exhausted", "B2 download authorization retry was exhausted", 401);
  }

  async #authorize(): Promise<B2Authorization> {
    if (this.#authorization) return this.#authorization;

    const basic = Buffer.from(`${this.#applicationKeyId}:${this.#applicationKey}`).toString("base64");
    const response = await this.#fetch(this.#authorizeUrl, { headers: { Authorization: `Basic ${basic}` } });
    if (!response.ok) await this.#throwResponseError(response);

    const payload = (await response.json()) as B2AuthorizePayload;
    const storageApi = payload.apiInfo?.storageApi;
    const apiUrl = storageApi?.apiUrl ?? payload.apiUrl;
    const downloadUrl = storageApi?.downloadUrl ?? payload.downloadUrl;
    const allowed = storageApi?.allowed ?? payload.allowed;
    const authorizationToken = storageApi?.authorizationToken ?? payload.authorizationToken;
    if (!apiUrl || !downloadUrl || !allowed || !authorizationToken) {
      throw new CloudProviderError("invalid_authorization_response", "B2 returned an incomplete authorization response", 502);
    }
    this.#authorization = {
      accountId: payload.accountId,
      authorizationToken,
      apiUrl,
      downloadUrl,
      allowed,
    };
    return this.#authorization;
  }

  async #apiRequest<T>(url: string, authorization: B2Authorization, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", authorization.authorizationToken);
    const response = await this.#fetch(url, { ...init, headers });
    if (!response.ok) {
      if (response.status === 401) this.#authorization = null;
      await this.#throwResponseError(response);
    }
    return (await response.json()) as T;
  }

  async #throwResponseError(response: Response): Promise<never> {
    let payload: B2ErrorPayload = {};
    try {
      payload = (await response.json()) as B2ErrorPayload;
    } catch {
      // B2 occasionally returns an empty proxy error. Keep the user-facing message generic.
    }
    throw new CloudProviderError(
      payload.code ?? `b2_http_${response.status}`,
      payload.message ?? `B2 request failed with HTTP ${response.status}`,
      payload.status ?? response.status,
    );
  }

  #assertBucket(bucket: CloudBucket): void {
    if (bucket.connectionId !== this.connectionId) {
      throw new CloudProviderError("wrong_connection", "Bucket does not belong to this B2 connection", 400);
    }
  }

  #toBucket(bucket: B2BucketPayload): CloudBucket {
    return {
      connectionId: this.connectionId,
      connectionLabel: this.connectionLabel,
      id: bucket.bucketId,
      name: bucket.bucketName,
    };
  }

  #toObject(file: B2FilePayload): CloudObject {
    return {
      id: file.fileId ?? null,
      name: file.fileName,
      kind: file.action === "folder" ? "folder" : "file",
      size: file.contentLength,
      uploadedAt: file.uploadTimestamp ? new Date(file.uploadTimestamp) : null,
    };
  }
}
