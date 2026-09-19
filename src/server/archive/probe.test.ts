import { describe, expect, test } from "bun:test";
import type { CloudBucket } from "../../shared/contracts";
import type { CloudObject, CloudStorageProvider, ListObjectOptions, ObjectPage, ReadObjectOptions } from "../cloud/provider";
import { probeArchive } from "./probe";

const bucket: CloudBucket = { connectionId: 1, connectionLabel: "test", id: "bucket", name: "bucket" };
const planId = "12345678-1234-1234-1234-123456789abc";

describe("archive probing", () => {
  test("marks a modern plan with snapshots as experimental Arq 6", async () => {
    const provider = new LayoutProvider(new Map([
      ["", [folder(`${planId}/`)]],
      [`${planId}/`, [
        file(`${planId}/backupconfig.json`),
        file(`${planId}/encryptedkeyset.dat`),
        folder(`${planId}/snapshots/`),
      ]],
    ]));
    provider.contents.set(`${planId}/backupconfig.json`, Buffer.from(JSON.stringify({ backupName: "Arq 6 Mac" })));

    const probe = await probeArchive(provider, bucket);
    expect(probe).toMatchObject({
      state: "locked",
      format: "arq6",
      plans: [{ id: planId, name: "Arq 6 Mac", format: "arq6", locked: true }],
    });
    expect(probe.message).toContain("experimental");
  });

  test("keeps backup-folder plans classified as Arq 7", async () => {
    const provider = new LayoutProvider(new Map([
      ["", [folder(`${planId}/`)]],
      [`${planId}/`, [
        file(`${planId}/backupconfig.json`),
        file(`${planId}/encryptedkeyset.dat`),
        folder(`${planId}/backupfolders/`),
      ]],
    ]));
    provider.contents.set(`${planId}/backupconfig.json`, Buffer.from("{}"));
    expect(await probeArchive(provider, bucket)).toMatchObject({ format: "arq7", plans: [{ format: "arq7" }] });
  });
});

class LayoutProvider implements CloudStorageProvider {
  readonly connectionId = 1;
  readonly connectionLabel = "test";
  readonly kind = "b2" as const;
  readonly contents = new Map<string, Uint8Array>();

  constructor(readonly pages: Map<string, CloudObject[]>) {}

  async listBuckets(): Promise<CloudBucket[]> {
    return [bucket];
  }

  async listObjects(_bucket: CloudBucket, options: ListObjectOptions = {}): Promise<ObjectPage> {
    return { objects: this.pages.get(options.prefix ?? "") ?? [], nextCursor: null };
  }

  async readObject(_bucket: CloudBucket, name: string, _options?: ReadObjectOptions): Promise<Uint8Array> {
    const value = this.contents.get(name);
    if (!value) throw new Error(`missing object ${name}`);
    return Uint8Array.from(value);
  }
}

function file(name: string): CloudObject {
  return { id: name, name, kind: "file", size: 1, uploadedAt: null };
}

function folder(name: string): CloudObject {
  return { id: null, name, kind: "folder", size: 0, uploadedAt: null };
}
