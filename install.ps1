# Install opencode-notify-qq into the global opencode config.
#
# Copies the client sources and the plugin into ~/.config/opencode/plugins/,
# then reports whether credentials are in place.
#
# Idempotent: safe to re-run.

$ErrorActionPreference = "Stop"

# Resolve the repo root. $PSScriptRoot is normally set for -File invocation, but
# fall back to $MyInvocation so the script also works when dot-sourced.
$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } elseif ($MyInvocation.MyCommand.Path) { Split-Path $MyInvocation.MyCommand.Path -Parent } else { (Get-Location).Path }
$repo = $scriptDir
$configDir = Join-Path $env:USERPROFILE ".config\opencode"
$pluginsDir = Join-Path $configDir "plugins"
$srcDir = Join-Path $pluginsDir "notify-qq"

if (-not (Test-Path (Join-Path $repo "src\qqbot.ts"))) {
    throw "cannot find src/qqbot.ts under '$repo'. Run this script from the repo root."
}

Write-Output "installing from: $repo"
Write-Output "target:          $pluginsDir"

New-Item -ItemType Directory -Force -Path $srcDir | Out-Null

Copy-Item (Join-Path $repo "src\qqbot.ts") (Join-Path $srcDir "qqbot.ts") -Force
Copy-Item (Join-Path $repo "src\config.ts") (Join-Path $srcDir "config.ts") -Force
Copy-Item (Join-Path $repo "plugins\notify-qq.ts") (Join-Path $pluginsDir "notify-qq.ts") -Force

$cfg = Join-Path $configDir "notify-qq.json"
Write-Output ""
if (Test-Path $cfg) {
    Write-Output "credentials file found: $cfg"
} else {
    Write-Output "credentials file MISSING: $cfg"
    Write-Output "Create it with an appId / clientSecret / notifyTarget (see README.md)."
}

Write-Output ""
Write-Output "installed. Restart opencode, then the agent has the notify_qq tool."
