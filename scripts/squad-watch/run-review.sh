#!/usr/bin/env bash
set -euo pipefail
test -n "${COPILOT_GITHUB_TOKEN:-}"
MODEL="$(node -e "process.stdout.write(require('./.watch-run/request.json').model)")"
CREDITS="$(node -e "const p=require(process.env.RUNNER_TEMP+'/squad-runtime/helper/policy.cjs'); process.stdout.write(p.creditInput(require('./.watch-run/request.json')))")"
[[ "$MODEL" == "claude-sonnet-5" ]]
CREDIT_ARGS=()
if [[ "$CREDITS" != "unset" ]]; then
  CREDIT_ARGS=(--max-ai-credits "$CREDITS")
fi
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
    --model "$MODEL" "${CREDIT_ARGS[@]}" \
    --no-ask-user --disable-builtin-mcps \
    --secret-env-vars=COPILOT_GITHUB_TOKEN --log-level none \
    --allow-all-tools \
    --deny-tool='shell(git push)' \
    --deny-tool='shell(gh)' \
    --deny-tool='shell(az)' --deny-tool='shell(azd)' \
    --deny-tool='shell(terraform)' --deny-tool='shell(copilot)' \
    --deny-tool='shell(npm)' --deny-tool='shell(dotnet)' \
    -p "$(cat .watch-run/prompt.txt)" >/dev/null 2>&1
RESULT=$?
set -e
printf 'cli_exit_code=%s\n' "$RESULT" >> "$GITHUB_OUTPUT"
if (( RESULT != 0 )); then
  echo "::error::Independent Squad static review exited nonzero (exit $RESULT); cause is unknown. Inspect safe runtime-status.json facts. No model output or misleading review will be published."
  exit "$RESULT"
fi
node "$RUNNER_TEMP/squad-runtime/helper/runtime.cjs" collect \
  "$COPILOT_HOME/session-state/$SESSION_ID/events.jsonl" \
  "$RUNNER_TEMP/squad-runtime/dispatch.json"
