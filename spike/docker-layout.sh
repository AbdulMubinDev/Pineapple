#!/usr/bin/env bash
# Task 2b fix round: the recommended layout in production shape (node:24-bookworm, 1 CPU, 768 MB).
#   docker run --rm --cpus 1 --memory 768m -v "<worktree>:/src:ro" node:24-bookworm \
#     bash /src/spike/docker-layout.sh "5 100 100" "5 150 100" ...
# Each argument is "isolates perIsolate steps [limitMB]"; runs one after another, each in its own
# Node process. Prints the bench's JSON lines.
set -uo pipefail
mkdir -p /work && cd /work
cp -r /src/package.json /src/package-lock.json /src/tsconfig.json /src/src /src/spike /src/tests .
npm ci --no-audit --no-fund --loglevel=error > /tmp/npm.log 2>&1 || { tail -20 /tmp/npm.log; exit 1; }
echo "## bare node process RSS: $(node -e 'console.log(Math.round(process.memoryUsage().rss/1e6))') MB"
node --import tsx spike/record-views.ts /tmp/views.json
for cfg in "$@"; do
  set -- $cfg
  echo "## layout-bench isolates=$1 perIsolate=$2 steps=$3 limitMB=${4:-256}"
  node --expose-gc --import tsx spike/layout-bench.ts /tmp/views.json "$1" "$2" "$3" 500 60 10 20 "${4:-256}"
  echo "## exit $?"
done
echo "## done"
