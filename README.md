# Arq Restore

Browse and restore Arq backups stored in Backblaze B2.

## Run

```sh
git clone https://github.com/tals/arq-backup.git
cd arq-backup
bun run dev
open http://127.0.0.1:3217
```

## Import your Arq connection

```sh
sudo bun run import:arq
```

## Scope

- Browse, search, and restore Arq backups from Backblaze B2.
- Cloud access is read-only; restores write only to your chosen local directory.

## Arq compatibility

| Version | Read | Write |
| --- | :---: | :---: |
| Arq 5 | Yes | No |
| Arq 6 | Experimental | No |
| Arq 7 | Yes | No |
