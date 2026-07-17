import type { CloudBucket } from "../../shared/contracts";
import { CredentialRepository } from "../credentials/credential-repository";
import { B2Provider } from "./b2-provider";
import type { CloudStorageProvider } from "./provider";

export class ProviderRegistry {
  readonly #providers = new Map<number, CloudStorageProvider>();

  constructor(readonly credentials: CredentialRepository) {}

  providers(): CloudStorageProvider[] {
    const credentials = this.credentials.listB2Credentials();
    const activeIds = new Set(credentials.map(credential => credential.id));
    for (const id of this.#providers.keys()) {
      if (!activeIds.has(id)) this.#providers.delete(id);
    }
    for (const credential of credentials) {
      if (!this.#providers.has(credential.id)) this.#providers.set(credential.id, new B2Provider(credential));
    }
    return [...this.#providers.values()];
  }

  provider(connectionId: number): CloudStorageProvider | null {
    this.providers();
    return this.#providers.get(connectionId) ?? null;
  }

  async listBuckets(): Promise<CloudBucket[]> {
    const groups = await Promise.all(this.providers().map(provider => provider.listBuckets()));
    return groups.flat().sort((a, b) => a.name.localeCompare(b.name) || a.connectionLabel.localeCompare(b.connectionLabel));
  }
}
