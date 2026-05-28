#!/usr/bin/env bash
# Nightly build wrapper. Run from a cron job or systemd timer.
#
# Exit codes from build-flags.mjs:
#   0  clean build                  -> commit + push
#   1  fatal (nothing was written)  -> alert, leave repo alone
#   2  shrink/prune guard tripped   -> alert, leave repo alone
#   3  partial build                -> commit + push BUT alert too
#
# Adjust REPO_DIR and BRANCH to taste.

set -u  # NB: no -e — we read exit codes ourselves.

REPO_DIR="${REPO_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
BRANCH="${BRANCH:-main}"
LOG_DIR="${LOG_DIR:-$REPO_DIR/logs}"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/build-$(date -u +%Y%m%dT%H%M%SZ).log"

cd "$REPO_DIR"

echo "==== nightly build $(date -u --iso-8601=seconds) ====" | tee -a "$LOG_FILE"
node scripts/build-flags.mjs 2>&1 | tee -a "$LOG_FILE"
status=${PIPESTATUS[0]}
echo "exit code: $status" | tee -a "$LOG_FILE"

case "$status" in
  0|3)
    # Clean (0) or partial (3) -> commit any data/PNG changes.
    if [[ -n "$(git status --porcelain data/ flags/)" ]]; then
      git add data/ flags/
      git commit -m "nightly build $(date -u +%Y-%m-%d) (exit=$status)" \
        --no-verify
      git push origin "$BRANCH"
      echo "committed + pushed." | tee -a "$LOG_FILE"
    else
      echo "no changes to commit." | tee -a "$LOG_FILE"
    fi
    ;;
  2)
    echo "GUARD TRIPPED — repo left as-is. Inspect $LOG_FILE." >&2
    ;;
  *)
    echo "FATAL ($status) — repo left as-is. Inspect $LOG_FILE." >&2
    ;;
esac

exit "$status"
