#!/usr/bin/env bash
set -euo pipefail

# ubuntu-24.04's documented runner image includes PowerShell 7. Assert it,
# rather than executing an unpinned installer or depending on ubuntu-latest.
command -v pwsh >/dev/null
pwsh -NoProfile -Command 'if ($PSVersionTable.PSVersion.Major -lt 7) { exit 1 }; $PSVersionTable.PSVersion.ToString()'

TOOLS="$RUNNER_TEMP/squad-tools"
mkdir -p "$TOOLS"
URL="https://github.com/microsoft/apm/releases/download/v0.29.0"
curl --fail --silent --show-error --location "$URL/apm-linux-x86_64.tar.gz" \
  --output "$TOOLS/apm-linux-x86_64.tar.gz"
curl --fail --silent --show-error --location "$URL/apm-linux-x86_64.tar.gz.sha256" \
  --output "$TOOLS/apm-linux-x86_64.tar.gz.sha256"
EXPECTED="53c98c50f436a8b5ac1d6a3cf443f94d29ed1e5385af52859cf1b1b512f71578"
[[ "$(awk '{print $1}' "$TOOLS/apm-linux-x86_64.tar.gz.sha256")" == "$EXPECTED" ]]
printf '%s  %s\n' "$EXPECTED" "$TOOLS/apm-linux-x86_64.tar.gz" | sha256sum --check --status
tar --extract --gzip --file "$TOOLS/apm-linux-x86_64.tar.gz" --directory "$TOOLS"
"$TOOLS/apm-linux-x86_64/apm" --version | grep -F '0.29.0'
node scripts/squad-watch/install-apm.cjs "$TOOLS/apm-linux-x86_64/apm"

RUNTIME_PLUGIN="$TOOLS/hve-squad-runtime"
test ! -e "$RUNTIME_PLUGIN"
mkdir -p "$RUNTIME_PLUGIN/agents/squad" "$RUNTIME_PLUGIN/skills"
cp scripts/squad-watch/runtime-plugin.json "$RUNTIME_PLUGIN/plugin.json"
cp .github/agents/*.agent.md "$RUNTIME_PLUGIN/agents/squad/"
cp -R .agents/skills/squad "$RUNTIME_PLUGIN/skills/squad"
test -f "$RUNTIME_PLUGIN/agents/squad/squad-federation-coordinator.agent.md"
test -f "$RUNTIME_PLUGIN/agents/squad/squad-scribe.agent.md"
test -f "$RUNTIME_PLUGIN/skills/squad/SKILL.md"

npm install --global --ignore-scripts "@github/copilot@1.0.98"
copilot --no-auto-update version | grep -F '1.0.98'
