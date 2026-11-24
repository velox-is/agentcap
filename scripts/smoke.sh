#!/usr/bin/env bash
# Milestone 1 smoke test: clean-clone path, init, start, three ports, task new, task kill, shutdown.
set -uo pipefail
cd "$(dirname "$0")/.."

TMP=$(mktemp -d)
cp -R package.json package-lock.json tsconfig.json .gitignore scripts src assets docs dist "$TMP/" 2>/dev/null
cd "$TMP"
ln -s "$(cd - >/dev/null && pwd)/node_modules" node_modules

PID=""
cleanup() {
  [ -n "$PID" ] && kill -9 "$PID" 2>/dev/null
  [ -n "${TMP:-}" ] && rm -rf "$TMP"
}
trap cleanup EXIT

fail() { echo "FAIL: $1"; exit 1; }

node dist/cli.js init >/dev/null 2>&1 || fail "init exited nonzero"
[ -f agentcap.config.json ] || fail "no config written"
[ -f agentcap.config.example.json ] || fail "no example written"
[ -f .agentcap/agentcap.db ] || fail "no db created"
echo "ok init"

OUT=$(node dist/cli.js init 2>&1); RC=$?
[ "$RC" -ne 0 ] || fail "second init exited 0"
echo "$OUT" | grep -q "already exists" && echo "ok init refuses overwrite" || fail "init did not refuse overwrite"

node dist/cli.js start > start.log 2>&1 &
PID=$!
for i in $(seq 1 50); do grep -q "agentcap up" start.log && break; sleep 0.1; done
grep -q "agentcap up" start.log || { cat start.log; fail "start never came up"; }
echo "ok start"

for p in 4100 4101 4102; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$p/health")
  [ "$code" = "200" ] && echo "ok health :$p" || fail "health :$p returned $code"
done

curl -s http://127.0.0.1:4102/ | grep -q agentcap && echo "ok dashboard serves html" || fail "dashboard did not serve page"

lsof -nP -iTCP:4100 -sTCP:LISTEN | grep -q 127.0.0.1:4100 && echo "ok bound to loopback" || fail "not bound to 127.0.0.1"

ID=$(node dist/cli.js task new --name smoke --max-tokens 1000)
[ -n "$ID" ] || fail "task new gave no id"
echo "ok task new -> $ID"

node -e "const D=require('better-sqlite3');const d=new D('.agentcap/agentcap.db');const r=d.prepare('select name,status,max_tokens from tasks where id=?').get('$ID');console.log(JSON.stringify(r));" | tee row.txt
grep -q '"max_tokens":1000' row.txt || fail "max_tokens not persisted"
grep -q '"status":"queued"' row.txt || fail "status not queued"

node dist/cli.js task kill "$ID" >/dev/null || fail "task kill failed"
node -e "const D=require('better-sqlite3');const d=new D('.agentcap/agentcap.db');console.log(d.prepare('select status from tasks where id=?').get('$ID').status);" | grep -qx killed && echo "ok task kill" || fail "status not killed"

OUT=$(node dist/cli.js task new 2>&1); RC=$?
[ "$RC" -ne 0 ] || fail "task new without --name exited 0"
echo "$OUT" | grep -q "needs --name" && echo "ok task new validates" || fail "task new accepted missing name"

OUT=$(node dist/cli.js task kill nope 2>&1); RC=$?
[ "$RC" -ne 0 ] || fail "task kill of unknown id exited 0"
echo "$OUT" | grep -q "no task" && echo "ok task kill rejects unknown" || fail "task kill accepted unknown id"

OUT=$(node dist/cli.js task new --name bad --max-tokens 0 2>&1); RC=$?
[ "$RC" -ne 0 ] || fail "--max-tokens 0 accepted"
echo "$OUT" | grep -q "positive number" && echo "ok cap validation" || fail "bad cap accepted"

kill -INT $PID; wait $PID 2>/dev/null
grep -q "agentcap down" start.log && echo "ok clean shutdown" || fail "no clean shutdown"
sleep 0.2
curl -s -m 1 http://127.0.0.1:4100/health >/dev/null 2>&1 && fail "proxy still listening" || echo "ok ports released"

echo "--- boot output ---
$(cat start.log)"
echo "PASS"
