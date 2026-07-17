import { appConfig } from "../server/config";
import { importArqB2Credentials } from "../server/import/arq-credential-importer";

process.umask(0o077);

if (process.getuid?.() !== 0) {
  console.error("This importer needs root access to read Arq's local credential store.");
  console.error("Run: sudo bun run import:arq");
  process.exit(1);
}

try {
  const dryRun = process.argv.slice(2).includes("--dry-run");
  const imported = importArqB2Credentials(appConfig.databasePath, { dryRun });
  if (dryRun) {
    console.log("Arq database opened read-only.");
    console.log("Arq local keyset authenticated (version 3).");
    console.log(`${imported.length} active B2 secret${imported.length === 1 ? "" : "s"} authenticated.`);
    console.log(`${imported.length} B2 connection${imported.length === 1 ? "" : "s"} would be imported.`);
  } else {
    for (const connection of imported) {
      const bucket = connection.bucketHint ? ` (bucket ${connection.bucketHint})` : "";
      console.log(`Imported ${connection.label}${bucket}.`);
    }
    console.log(`Credential database: ${appConfig.databasePath}`);
  }
  console.log("No Arq encryption password, master key, or derived key was saved.");
} catch (error) {
  console.error(`Import failed: ${error instanceof Error ? error.message : "Unknown error"}`);
  process.exit(1);
}
