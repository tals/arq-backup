import { describe, expect, test } from "bun:test";
import { CredentialRepository } from "./credential-repository";

describe("credential repository", () => {
  test("upserts a connection without a bucket hint idempotently", () => {
    const repository = new CredentialRepository(":memory:");
    try {
      const input = {
        label: "B2",
        applicationKeyId: "key-id",
        applicationKey: "first-secret",
        bucketHint: null,
      };
      const first = repository.upsertB2Credential(input);
      const second = repository.upsertB2Credential({ ...input, applicationKey: "updated-secret" });
      expect(second.id).toBe(first.id);
      expect(repository.listConnections()).toHaveLength(1);
      expect(repository.getB2Credential(first.id)?.applicationKey).toBe("updated-secret");
      expect(repository.getB2Credential(first.id)?.bucketHint).toBeNull();
    } finally {
      repository.close();
    }
  });

  test("imports multiple connections in one transaction", () => {
    const repository = new CredentialRepository(":memory:");
    try {
      const stored = repository.upsertB2Credentials([
        { label: "One", applicationKeyId: "one", applicationKey: "secret-1", bucketHint: "bucket-1" },
        { label: "Two", applicationKeyId: "two", applicationKey: "secret-2", bucketHint: "bucket-2" },
      ]);
      expect(stored.map(connection => connection.label)).toEqual(["One", "Two"]);
      expect(repository.listConnections()).toHaveLength(2);
    } finally {
      repository.close();
    }
  });
});
