#!/usr/bin/env bash
# CI gate. The pre-push hook only runs locally, and only if hooksPath is set;
# this fails the build instead of letting a wrong identity reach a stranger.
set -uo pipefail
cd "$(dirname "$0")/.."

fail=0

url=$(git remote get-url origin 2>/dev/null || echo none)
case "$url" in
  *velox-is/agentcap*) ;;
  *) echo "remote is not velox-is/agentcap: $url"; fail=1 ;;
esac

name=$(git config user.name || echo none)
email=$(git config user.email || echo none)
[ "$name" = "Veloxis" ] || { echo "user.name is '$name'"; fail=1; }
case "$email" in
  *velox-is@users.noreply.github.com) ;;
  *) echo "user.email is '$email'"; fail=1 ;;
esac

# Every commit must carry the noreply address; veloxis.dev is unregistered.
bad=$(git log --format='%ae' | sort -u | grep -v 'velox-is@users.noreply.github.com' || true)
[ -z "$bad" ] || { echo "commits authored by: $bad"; fail=1; }

# The retired handle and the unregistered domain must appear nowhere a reader
# can see them.
# Excludes itself and AGENTS.md: both name the retired handle on purpose.
hits=$(grep -rn 'J0SEPH-K\|veloxis\.dev' --exclude-dir=node_modules --exclude-dir=.git \
  --exclude-dir=dist --exclude='*.tgz' --exclude='check-identity.sh' --exclude='AGENTS.md' . 2>/dev/null || true)
[ -z "$hits" ] || { echo "retired handle or domain:"; echo "$hits"; fail=1; }

[ "$fail" -eq 0 ] && echo "identity ok: Veloxis <$email> -> $url"
exit "$fail"
