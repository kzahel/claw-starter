#!/usr/bin/env bash
# check-repos.sh — Check git repos for sync status.
# Usage: check-repos.sh [path ...] [--no-fetch]
#
# Paths can be:
#   - Direct repo paths (contain .git/) — checked as-is
#   - Parent directories — each subdirectory with .git/ is checked
#
# Exit code: 0 if all repos clean and synced, 1 if any need attention.

set -euo pipefail

PATHS=()
DO_FETCH=true

for arg in "$@"; do
  case "$arg" in
    --no-fetch) DO_FETCH=false ;;
    *) PATHS+=("$arg") ;;
  esac
done

if [ ${#PATHS[@]} -eq 0 ]; then
  PATHS=("$HOME/code")
fi

# Resolve paths to actual repo directories
REPOS=()
for p in "${PATHS[@]}"; do
  expanded=$(eval echo "$p")
  if [ ! -d "$expanded" ]; then
    echo "WARNING: $expanded is not a directory, skipping"
    continue
  fi
  if [ -d "$expanded/.git" ]; then
    # Direct repo path
    REPOS+=("$expanded")
  else
    # Parent directory — scan subdirectories
    for repo_dir in "$expanded"/*/; do
      [ -d "$repo_dir/.git" ] && REPOS+=("${repo_dir%/}")
    done
  fi
done

needs_attention=0
clean_count=0
problem_repos=()

for repo_dir in "${REPOS[@]}"; do
  repo_name=$(basename "$repo_dir")
  issues=()

  # Fetch from remote
  if $DO_FETCH; then
    if ! git -C "$repo_dir" fetch --quiet 2>/dev/null; then
      issues+=("  fetch failed (no remote or network issue)")
    fi
  fi

  # Uncommitted changes
  dirty=$(git -C "$repo_dir" status --porcelain 2>/dev/null)
  if [ -n "$dirty" ]; then
    modified=$(echo "$dirty" | grep -c '^ M\| ^M\|^MM' || true)
    untracked=$(echo "$dirty" | grep -c '^??' || true)
    staged=$(echo "$dirty" | grep -c '^[MADRC]' || true)
    summary=""
    [ "$staged" -gt 0 ] && summary+="${staged} staged "
    [ "$modified" -gt 0 ] && summary+="${modified} modified "
    [ "$untracked" -gt 0 ] && summary+="${untracked} untracked"
    issues+=("  dirty: ${summary}")
  fi

  # Unpushed commits
  unpushed=$(git -C "$repo_dir" log @{u}..HEAD --oneline 2>/dev/null || echo "")
  if [ -n "$unpushed" ]; then
    count=$(echo "$unpushed" | wc -l | tr -d ' ')
    latest=$(echo "$unpushed" | head -1)
    issues+=("  unpushed: ${count} commit(s) — latest: ${latest}")
  fi

  # Unpulled commits
  unpulled=$(git -C "$repo_dir" log HEAD..@{u} --oneline 2>/dev/null || echo "")
  if [ -n "$unpulled" ]; then
    count=$(echo "$unpulled" | wc -l | tr -d ' ')
    issues+=("  behind remote: ${count} commit(s)")
  fi

  # Stashes
  stashes=$(git -C "$repo_dir" stash list 2>/dev/null)
  if [ -n "$stashes" ]; then
    count=$(echo "$stashes" | wc -l | tr -d ' ')
    issues+=("  stashes: ${count}")
  fi

  if [ ${#issues[@]} -gt 0 ]; then
    problem_repos+=("$repo_name")
    echo "$repo_name"
    for issue in "${issues[@]}"; do
      echo "$issue"
    done
    echo ""
    needs_attention=1
  else
    clean_count=$((clean_count + 1))
  fi
done

echo "---"
total=${#REPOS[@]}
if [ $needs_attention -eq 1 ]; then
  echo "${#problem_repos[@]} repo(s) need attention, ${clean_count} clean (${total} total)"
else
  echo "All ${clean_count} repos clean and synced (${total} total)"
fi

exit $needs_attention
