#!/usr/bin/env bash
# Head-to-head harness benchmark: run the same prompt headless on a model and
# record wall time plus tiny-coder's [stats] line.
#
#   bench/run.sh <label> <model> [effort] [extra tiny-coder flags...]
#   bench/run.sh mc-ollama   qwen3.8:latest      off
#   bench/run.sh mc-lmstudio qwen/qwen3.8-27b    off
#   bench/run.sh mc-compact  qwen3.8:latest      off --ctx 12000   # force compaction
#
# Output goes to playground/<label>/ (gitignored) and bench/out/<label>.log.
# Only one backend can hold a big model on one GPU: unload the other first
# (`lms unload --all`, or an Ollama chat with "keep_alive": 0).
set -u
label="$1"; model="$2"; effort="${3:-off}"; shift 3 || shift $#
root="$(cd "$(dirname "$0")/.." && pwd)"
prompt="${BENCH_PROMPT:-$root/bench/minecraft-prompt.txt}"
ws="$root/playground/$label"
mkdir -p "$root/bench/out" "$ws"
log="$root/bench/out/$label.log"
start=$(date +%s)
echo "[bench] start $(date -Iseconds) label=$label model=$model effort=$effort flags=$*" | tee "$log"
node "$root/dist/index.js" "$ws" -p "$(cat "$prompt")" --mode yolo --effort "$effort" --model "$model" "$@" >> "$log" 2>&1
code=$?
echo "[bench] end $(date -Iseconds) exit=$code wall=$(( $(date +%s) - start ))s" | tee -a "$log"
grep -E "^\[stats\]" "$log" | tail -1
