#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${COPILOT_GITHUB_TOKEN:-}" ]]; then
  echo "::error::Missing dedicated Copilot Requests-only COPILOT_GITHUB_TOKEN."
  exit 1
fi
MODEL="$(node -e "process.stdout.write(require('./.watch-run/request.json').model)")"
CREDITS="$(node -e "process.stdout.write(String(require('./.watch-run/request.json').maxAiCredits))")"
[[ "$MODEL" == "claude-sonnet-5" && "$CREDITS" =~ ^[0-9]+$ ]]
(( CREDITS >= 30 && CREDITS <= 90 ))

# Only the Requests-only credential reaches the CLI. Its tool subprocesses
# receive no copy of that secret. No raw CLI output/session artifact is published.
unset GH_TOKEN GITHUB_TOKEN
readonly REPO_ROOT="$PWD"
export HVE_WATCH_REPO_ROOT="$REPO_ROOT"
readonly RUNTIME_PLUGIN="$RUNNER_TEMP/squad-tools/hve-squad-runtime"
test -f "$RUNTIME_PLUGIN/plugin.json"
readonly SESSION_ID="$(node -e "process.stdout.write(require('node:crypto').randomUUID())")"
export COPILOT_HOME="$RUNNER_TEMP/squad-runtime/copilot-home"
test ! -e "$COPILOT_HOME"
test ! -e "$RUNNER_TEMP/squad-runtime/dispatch.json"
mkdir -p "$COPILOT_HOME"
node "$RUNNER_TEMP/squad-runtime/helper/completion-gate.cjs" init "$SESSION_ID"
set +e
timeout --signal=TERM --kill-after=30s 30m \
  copilot --no-auto-update \
    -C "$REPO_ROOT" \
    --add-dir "$REPO_ROOT" \
    --plugin-dir "$RUNTIME_PLUGIN" \
    --agent hve-squad:squad-federation-coordinator \
    --session-id "$SESSION_ID" \
    --model "$MODEL" \
    --max-ai-credits "$CREDITS" \
    --no-ask-user \
    --disable-builtin-mcps \
    --secret-env-vars=COPILOT_GITHUB_TOKEN \
    --log-level none \
    --allow-all-tools \
    --deny-tool='shell(git push)' \
    --deny-tool='shell(gh pr)' \
    --deny-tool='shell(gh issue)' \
    --deny-tool='shell(az)' \
    --deny-tool='shell(azd)' \
    --deny-tool='shell(terraform)' \
    --deny-tool='shell(copilot)' \
    -p "$(cat .watch-run/prompt.txt)" \
    >/dev/null 2>&1
RESULT=$?
set -e
printf 'cli_exit_code=%s\n' "$RESULT" >> "$GITHUB_OUTPUT"
if (( RESULT != 0 )); then
  echo "::error::Squad interpretation exited nonzero (exit $RESULT); cause is unknown. Inspect safe runtime-status.json facts. Raw CLI output is intentionally not published; no mutation handoff will be applied."
  exit "$RESULT"
fi
node "$RUNNER_TEMP/squad-runtime/helper/runtime.cjs" collect \
  "$COPILOT_HOME/session-state/$SESSION_ID/events.jsonl" \
  "$RUNNER_TEMP/squad-runtime/dispatch.json"
