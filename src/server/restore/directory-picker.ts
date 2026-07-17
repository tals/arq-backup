import { isAbsolute } from "node:path";
import { ArchiveFormatError } from "../archive/common/errors";

const CHOOSE_FOLDER_SCRIPT = 'POSIX path of (choose folder with prompt "Choose a folder for restored backup data")';

export async function chooseLocalRestoreDirectory(): Promise<string | null> {
  if (process.platform !== "darwin") {
    throw new ArchiveFormatError("unsupported_directory_picker", "The native directory picker currently supports macOS only; enter an absolute path manually");
  }
  const child = Bun.spawn(["/usr/bin/osascript", "-e", CHOOSE_FOLDER_SCRIPT], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    if (/user canceled/i.test(stderr)) return null;
    throw new Error(stderr.trim() || `Native directory picker exited with status ${exitCode}`);
  }
  const path = stdout.replace(/[\r\n]+$/, "");
  if (!isAbsolute(path)) throw new Error("Native directory picker returned a non-absolute path");
  return path;
}
