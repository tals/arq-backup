import type { ArchiveProbe, BackupPlanSummary, CloudBucket } from "../../shared/contracts";
import type { CloudStorageProvider } from "../cloud/provider";

const LEGACY_KEY_SET = "encrypted_master_keys.dat";
const LEGACY_PLANS_PREFIX = "plans/";

export async function probeArchive(
  provider: CloudStorageProvider,
  bucket: CloudBucket,
): Promise<ArchiveProbe> {
  const root = await provider.listObjects(bucket, { delimiter: "/", limit: 1_000 });
  if (root.objects.length === 0) {
    return {
      state: "empty",
      format: null,
      message: "This bucket is empty.",
      plans: [],
    };
  }

  const hasLegacyKeySet = root.objects.some(object => object.kind === "file" && object.name === LEGACY_KEY_SET);
  const hasLegacyPlans = root.objects.some(
    object => object.kind === "folder" && object.name === LEGACY_PLANS_PREFIX,
  );
  if (hasLegacyKeySet && hasLegacyPlans) {
    const plans = await listLegacyPlans(provider, bucket);
    return {
      state: "locked",
      format: "arq-legacy",
      message: "Enter the Arq Encryption Password to open these backup plans.",
      plans,
    };
  }

  const rootNames = root.objects.map(object => object.name);
  const [arq7Plans, legacyComputers] = await Promise.all([
    listArq7Plans(provider, bucket, rootNames),
    listLegacyComputers(provider, bucket, rootNames),
  ]);
  const plans = [...arq7Plans, ...legacyComputers];
  if (plans.length > 0) {
    return {
      state: "locked",
      format: arq7Plans.length > 0 && legacyComputers.length > 0
        ? "mixed"
        : arq7Plans.length > 0 ? "arq7" : "arq5",
      message: legacyComputers.length > 0
        ? "Current Arq 7 plans and older computer backups were found in this bucket."
        : "Enter the Arq Encryption Password to open these backup plans.",
      plans: plans.sort((left, right) => left.name.localeCompare(right.name)),
    };
  }

  return {
    state: "unsupported",
    format: null,
    message: "No supported Arq backups were found in this bucket.",
    plans: [],
  };
}

async function listLegacyPlans(
  provider: CloudStorageProvider,
  bucket: CloudBucket,
): Promise<BackupPlanSummary[]> {
  const page = await provider.listObjects(bucket, { prefix: LEGACY_PLANS_PREFIX, delimiter: "/", limit: 10_000 });
  return page.objects
    .filter(object => object.kind === "folder")
    .map(object => object.name.slice(LEGACY_PLANS_PREFIX.length).replace(/\/$/, ""))
    .filter(Boolean)
    .map(id => ({ id, name: id, locked: true, format: "arq-legacy" as const }));
}

async function listArq7Plans(
  provider: CloudStorageProvider,
  bucket: CloudBucket,
  rootNames: string[],
): Promise<BackupPlanSummary[]> {
  const candidateIds = rootNames
    .filter(name => name.endsWith("/"))
    .map(name => name.slice(0, -1))
    .filter(name => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(name));

  const plans = await Promise.all(candidateIds.map(async id => {
    const prefix = `${id}/`;
    const page = await provider.listObjects(bucket, { prefix, delimiter: "/", limit: 100 });
    const names = new Set(page.objects.map(object => object.name));
    if (!names.has(`${prefix}backupconfig.json`) || !names.has(`${prefix}encryptedkeyset.dat`)) return null;

    let name = id;
    try {
      const config = parseJsonObject(await provider.readObject(bucket, `${prefix}backupconfig.json`));
      name = firstString(config, ["backupName", "computerName", "name", "planName", "displayName"]) ?? id;
    } catch {
      // The structural markers are sufficient. Unlocking will surface corrupt config precisely.
    }
    return { id, name, locked: true, format: "arq7" } satisfies BackupPlanSummary;
  }));
  return plans.filter((plan): plan is NonNullable<typeof plan> => plan !== null)
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function listLegacyComputers(
  provider: CloudStorageProvider,
  bucket: CloudBucket,
  rootNames: string[],
): Promise<BackupPlanSummary[]> {
  const candidateIds = rootNames
    .filter(name => name.endsWith("/"))
    .map(name => name.slice(0, -1))
    .filter(name => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(name));

  const computers = await Promise.all(candidateIds.map(async id => {
    const prefix = `${id}/`;
    const page = await provider.listObjects(bucket, { prefix, delimiter: "/", limit: 100 });
    const names = new Set(page.objects.map(object => object.name));
    const hasComputerInfo = names.has(`${prefix}computerinfo`);
    const hasEncryption = names.has(`${prefix}encryptionv2.dat`) || names.has(`${prefix}encryptionv3.dat`);
    const hasBuckets = names.has(`${prefix}buckets/`);
    if (!hasComputerInfo || !hasEncryption || !hasBuckets) return null;

    let name = id;
    try {
      const info = new TextDecoder("utf-8", { fatal: true }).decode(
        await provider.readObject(bucket, `${prefix}computerinfo`),
      );
      name = plistString(info, "computerName") ?? id;
    } catch {
      // The layout markers are conclusive; keep the UUID if metadata is damaged.
    }
    return { id, name, locked: true, format: "arq5" } satisfies BackupPlanSummary;
  }));
  return computers.filter((computer): computer is NonNullable<typeof computer> => computer !== null);
}

function plistString(xml: string, key: string): string | null {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`<key>\\s*${escapedKey}\\s*<\\/key>\\s*<string>([^<]*)<\\/string>`, "i").exec(xml);
  return match?.[1] ? decodeXml(match[1]).trim() || null : null;
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function parseJsonObject(bytes: Uint8Array): Record<string, unknown> {
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object");
  return value as Record<string, unknown>;
}

function firstString(value: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return null;
}
