---
name: git-sync
description: "Scan local git repos for dirty trees, unpushed/unpulled commits, and stashes — keep machines in sync"
---

# git-sync

Check git repositories for sync issues: uncommitted changes, unpushed commits, commits behind remote, and stashes.

## Usage

Run the check script using the `git-sync` tool path:

```bash
git-sync [path ...] [--no-fetch]
```

### Arguments

- **paths** — Repo paths or parent directories. Direct repo paths (with `.git/`) are checked as-is. Parent directories are scanned for subdirectories containing `.git/`. Default: `~/code` (scans all repos).
- **--no-fetch** — Skip `git fetch` (faster, but won't detect unpulled commits).

### Config

The skill config provides the repo whitelist:

```yaml
git-sync:
  repos:
    - ~/code/jstorrent
    - ~/code/yepanywhere
    - ~/code/dotfiles
```

Build the CLI args from config: pass each `repos` entry as a positional arg.

### Example

```bash
git-sync ~/code/jstorrent ~/code/yepanywhere ~/code/dotfiles
```

## Output

The script prints each repo that needs attention with its issues, then a summary line:

```
yepanywhere
  dirty: 2 modified 1 untracked
  unpushed: 3 commit(s) — latest: abc1234 Fix thing

dotfiles
  behind remote: 2 commit(s)

---
2 repo(s) need attention, 8 clean (10 total)
```

Exit code 0 = all clean, 1 = something needs attention.

## Behavior by trigger mode

- **Interactive:** Run the check, report results. If repos need attention, offer to fix them (pull, push, show diffs). Ask before taking action.
- **Cron/Channel:** Run the check, report results only. Don't attempt fixes — just flag what needs attention.

## Fixing issues

When in interactive mode and repos need attention:

- **Dirty tree:** Show `git diff --stat` for the repo. Ask if user wants to commit, stash, or leave it.
- **Unpushed:** Ask if user wants to push.
- **Behind remote:** Ask if user wants to pull (warn if tree is also dirty — suggest stash first).
- **Stashes:** Just mention them. Don't offer to pop unless asked.

Never force-push or reset without explicit user request.
