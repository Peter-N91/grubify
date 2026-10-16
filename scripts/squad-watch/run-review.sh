#!/usr/bin/env bash
set -euo pipefail
test -n "${COPILOT_GITHUB_TOKEN:-}"
MODEL="$(node -e "process.stdout.write(require('./.watch-run/request.json').model)")"
CREDITS="$(node -e "process.stdout.write(String(require('./.watch-run/request.json').maxAiCredits))")"
[[ "$MODEL" == "claude-sonnet-5" && "$CREDITS" == "90" ]]
unset GH_TOKEN GITHUB_TOKEN
export COPILOT_HOME="$PWD/.watch-run/copilot-review-home"
mkdir -p "$COPILOT_HOME"
set +e
timeout --signal=TERM --kill-after=30s 30m \
  copilot --no-auto-update \
    --agent squad-federation-coordinator \
    --model "$MODEL" --max-ai-credits "$CREDITS" \
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
  echo "::error::Independent Squad static review failed or exhausted its time/soft-credit allowance (exit $RESULT). No model output or misleading review will be published."
  exit "$RESULT"
fi
