# Install opencode-notify-qq into the global opencode config.
#
# Copies the client sources and the plugin into ~/.config/opencode/plugins/,
# installs a `notify-qq` shell function, and reports whether credentials are
# in place.
#
# Idempotent: safe to re-run.

param(
    # Skip adding the shell function to $PROFILE.
    [switch]$SkipShellFunction
)

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
Copy-Item (Join-Path $repo "src\notify-qq.ps1") (Join-Path $srcDir "notify-qq.ps1") -Force

# Shell function so `notify-qq on|off|status` works in any terminal.
#
# Written into BOTH the Windows PowerShell 5.1 and PowerShell 7 profiles: the
# installer may run under either, but the user's interactive shell is usually
# pwsh 7, so installing only into the caller's profile would silently miss it.
if (-not $SkipShellFunction) {
    $cliScript = Join-Path $srcDir "notify-qq.ps1"
    $begin = "# >>> opencode-notify-qq >>>"
    $end = "# <<< opencode-notify-qq <<<"
    $block = @"
$begin
function notify-qq {
    param([Parameter(Position = 0)][string]`$Action = 'status')
    & "$cliScript" `$Action
}
$end
"@

    $docs = [Environment]::GetFolderPath("MyDocuments")
    $profiles = @(
        (Join-Path $docs "WindowsPowerShell\profile.ps1"),  # PS 5.1
        (Join-Path $docs "PowerShell\profile.ps1")          # pwsh 7
    )

    foreach ($profilePath in $profiles) {
        $profileDir = Split-Path $profilePath -Parent
        if (-not (Test-Path $profileDir)) { New-Item -ItemType Directory -Force -Path $profileDir | Out-Null }
        if (-not (Test-Path $profilePath)) { New-Item -ItemType File -Force -Path $profilePath | Out-Null }

        $existing = Get-Content $profilePath -Raw -ErrorAction SilentlyContinue
        if ($null -eq $existing) { $existing = "" }

        $pattern = "(?s)" + [regex]::Escape($begin) + ".*?" + [regex]::Escape($end)
        if ($existing -match $pattern) {
            $updated = [regex]::Replace($existing, $pattern, $block)
        } else {
            $sep = if ($existing.TrimEnd().Length -gt 0) { "`r`n`r`n" } else { "" }
            $updated = $existing.TrimEnd() + $sep + $block + "`r`n"
        }
        [System.IO.File]::WriteAllText($profilePath, $updated, (New-Object System.Text.UTF8Encoding($false)))
        Write-Output "shell function installed in: $profilePath"
    }
    Write-Output "  (open a new terminal, then: notify-qq on|off|status)"
}

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
