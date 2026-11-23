#!/usr/bin/env bash
# Task 2b benches inside node:24-bookworm, 1 CPU, 768 MB (production shape). Run from the host:
#   docker run --rm --cpus 1 --memory 768m -v "<worktree>:/src:ro" node:24-bookworm bash /src/spike/docker-resident.sh
# Copies the worktree into the container, installs from the lockfile, runs each bench in turn.
set -euo pipefail
mkdir -p /work && cd /work
cp -r /src/package.json /src/package-lock.json /src/tsconfig.json /src/src /src/spike /src/tests .
npm ci --no-audit --no-fund --loglevel=error > /tmp/npm.log 2>&1 || { tail -20 /tmp/npm.log; exit 1; }
run() { echo "## $*"; node --expose-gc --import tsx "$@"; }
# Node, no isolate: 50 instances, tight and default bounds, and untrimmed for comparison.
run spike/resident-bench.ts 50 60 10 500 1500 20
run spike/resident-bench.ts 50 100 50 500 1500
run spike/resident-bench.ts 50 0 0 500 1000
# One isolate with 50 trimmed instances (tight / default), plus 10 one-instance isolates.
run spike/resident-isolate.ts 50 1000 10 60 10 20 500 256
run spike/resident-isolate.ts 50 1000 0 100 50 100 500 256
# Capacity: 1,000 tight instances in one 512 MB isolate inside the 768 MB container.
run spike/resident-isolate.ts 1000 200 0 60 10 20 500 512
echo "## done"
