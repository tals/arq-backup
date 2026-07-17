# Arq Restore

Arq Restore lets a person navigate cloud-hosted Arq backups and recover their contents.

## Language

**Cloud Browser**:
The navigation hierarchy for cloud-hosted backups: Bucket → Backup Plan → Backup Record → Volume → Folder or File. It presents decoded backup contents rather than raw storage objects.
_Avoid_: Object browser, key browser

**Bucket**:
A top-level cloud storage container and the entry point into the backups it contains.
_Avoid_: Repository, root folder

**Backup Plan**:
An Arq backup definition whose history is represented by Backup Records.
_Avoid_: Computer, plan repository

**Backup Record**:
An immutable point-in-time state captured by a Backup Plan.
_Avoid_: Commit, version

**Volume**:
A filesystem root captured within a Backup Record.
_Avoid_: Disk

**Backup Item**:
A Folder or File contained in a Volume.
_Avoid_: Object, node

**Restore**:
The reconstruction of a File or an entire Folder from a Backup Record onto the local filesystem. A Restore reads from a Bucket but never changes it.
_Avoid_: Download, export

**Restore Job**:
A request to Restore one File or Folder to a chosen local destination, with observable queue status and progress.
_Avoid_: Fetch, download task

**Restore Queue**:
The ordered collection of pending and active Restore Jobs processed with bounded concurrency.
_Avoid_: Download list

**Complete File**:
A restored local File whose byte length and modification time match its corresponding Backup Item. A Complete File may be skipped without comparing its contents.
_Avoid_: Fully materialized file, verified file

**Partial File**:
An incomplete plaintext File retained beside its intended destination after a Restore is canceled or fails.
_Avoid_: Temporary file, cache file

**Encryption Password**:
The user-supplied secret that unlocks an Arq backup's encrypted key material for the current session.
_Avoid_: B2 application key, account password
