import { describe, expect, test } from "bun:test";
import type { B2Credential } from "../credentials/credential-repository";
import { B2Provider } from "./b2-provider";

const credential: B2Credential = {
  id: 7,
  label: "Personal B2",
  applicationKeyId: "key-id",
  applicationKey: "secret-key",
  bucketHint: null,
};

describe("B2 provider", () => {
  test("authorizes, lists buckets, and keeps provider details behind the boundary", async () => {
    const requests: Request[] = [];
    const mockFetch = mockB2Fetch(requests, {
      capabilities: ["listBuckets", "listFiles", "readFiles"],
      buckets: [
        { bucketId: "z", bucketName: "zeta" },
        { bucketId: "a", bucketName: "alpha" },
      ],
    });
    const provider = new B2Provider(credential, { fetch: mockFetch, authorizeUrl: "https://auth.test/authorize" });

    expect(await provider.listBuckets()).toEqual([
      { connectionId: 7, connectionLabel: "Personal B2", id: "a", name: "alpha" },
      { connectionId: 7, connectionLabel: "Personal B2", id: "z", name: "zeta" },
    ]);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.headers.get("authorization")).toBe(`Basic ${Buffer.from("key-id:secret-key").toString("base64")}`);
    expect(requests[1]?.url).toContain("/b2api/v4/b2_list_buckets?accountId=account-1");
  });

  test("synthesizes the allowed bucket for a bucket-restricted key", async () => {
    const requests: Request[] = [];
    const mockFetch = mockB2Fetch(requests, {
      capabilities: ["listFiles", "readFiles"],
      bucketId: "only-id",
      bucketName: "only-bucket",
      buckets: [],
    });
    const provider = new B2Provider(credential, { fetch: mockFetch, authorizeUrl: "https://auth.test/authorize" });

    expect(await provider.listBuckets()).toEqual([
      { connectionId: 7, connectionLabel: "Personal B2", id: "only-id", name: "only-bucket" },
    ]);
    expect(requests).toHaveLength(1);
  });

  test("lists virtual folders and reads encoded object names", async () => {
    const requests: Request[] = [];
    const mockFetch = mockB2Fetch(requests, {
      capabilities: ["listBuckets", "listFiles", "readFiles"],
      buckets: [{ bucketId: "bucket-1", bucketName: "archive bucket" }],
      files: [{ action: "folder", contentLength: 0, fileName: "plans/" }],
    });
    const provider = new B2Provider(credential, { fetch: mockFetch, authorizeUrl: "https://auth.test/authorize" });
    const bucket = (await provider.listBuckets())[0]!;
    expect(await provider.listObjects(bucket, { prefix: "p", delimiter: "/" })).toMatchObject({
      objects: [{ name: "plans/", kind: "folder", size: 0 }],
    });
    const listRequest = requests.find(request => request.url.endsWith("/b2api/v4/b2_list_file_names"))!;
    expect(listRequest.method).toBe("POST");
    expect(await listRequest.json()).toEqual({
      bucketId: "bucket-1",
      maxFileCount: 1_000,
      prefix: "p",
      delimiter: "/",
    });
    expect(new TextDecoder().decode(await provider.readObject(bucket, "folder/a b"))).toBe("payload");
    expect(requests.at(-1)?.url).toBe("https://download.test/file/archive%20bucket/folder/a%20b");
  });

  test("puts Arq UUID prefixes and cursors in the JSON body", async () => {
    const requests: Request[] = [];
    const mockFetch = mockB2Fetch(requests, {
      capabilities: ["listBuckets", "listFiles", "readFiles"],
      buckets: [{ bucketId: "bucket-1", bucketName: "archive" }],
      files: [],
    });
    const provider = new B2Provider(credential, { fetch: mockFetch, authorizeUrl: "https://auth.test/authorize" });
    const bucket = (await provider.listBuckets())[0]!;
    const prefix = "15AF821A-510E-40AC-B3A8-DD42CC4D2C79/packsets/14C7D0CD-F60A-4F6A-AE31-87BDDBB3250A-trees/";
    await provider.listObjects(bucket, { prefix, delimiter: "/", cursor: `${prefix}next.index` });

    const listRequest = requests.find(request => request.url.endsWith("/b2api/v4/b2_list_file_names"))!;
    expect(listRequest.url.includes("?")).toBe(false);
    expect(await listRequest.json()).toMatchObject({ prefix, startFileName: `${prefix}next.index` });
  });
});

function mockB2Fetch(
  requests: Request[],
  options: {
    capabilities: string[];
    bucketId?: string;
    bucketName?: string;
    buckets: Array<{ bucketId: string; bucketName: string }>;
    files?: Array<{ action: string; contentLength: number; fileName: string }>;
  },
): typeof globalThis.fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    if (request.url === "https://auth.test/authorize") {
      return Response.json({
        accountId: "account-1",
        apiInfo: {
          storageApi: {
            apiUrl: "https://api.test",
            downloadUrl: "https://download.test",
            authorizationToken: "auth-token",
            allowed: {
              capabilities: options.capabilities,
              bucketId: options.bucketId ?? null,
              bucketName: options.bucketName ?? null,
              namePrefix: null,
            },
          },
        },
      });
    }
    if (request.url.startsWith("https://api.test/b2api/v4/b2_list_buckets")) {
      return Response.json({ buckets: options.buckets });
    }
    if (request.url.startsWith("https://api.test/b2api/v4/b2_list_file_names")) {
      return Response.json({ files: options.files ?? [], nextFileName: null });
    }
    if (request.url.startsWith("https://download.test/file/")) return new Response("payload");
    return Response.json({ code: "unexpected", message: "Unexpected mock request", status: 500 }, { status: 500 });
  }) as typeof globalThis.fetch;
}
