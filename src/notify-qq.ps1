# Read or change the idle-notify switch from the shell.
#
#   notify-qq            -> show status
#   notify-qq on         -> enable (ping me when a turn finishes)
#   notify-qq off        -> disable
#
# Works while opencode is running: the plugin re-reads the config on every
# event, so the change takes effect immediately. Nothing here talks to opencode.

param(
    [Parameter(Position = 0)][string]$Action = "status"
)

$ErrorActionPreference = "Stop"

$configPath = Join-Path $env:USERPROFILE ".config\opencode\notify-qq.json"

if (-not (Test-Path $configPath)) {
    Write-Output "config not found: $configPath"
    Write-Output "run the opencode-notify-qq installer first."
    exit 1
}

# Preserve every other field; only touch idleNotify.
$config = Get-Content $configPath -Raw | ConvertFrom-Json

switch ($Action.ToLower()) {
    "on" {
        $config.idleNotify = [pscustomobject]@{ enabled = $true }
        $json = $config | ConvertTo-Json -Depth 12
        [System.IO.File]::WriteAllText($configPath, $json, (New-Object System.Text.UTF8Encoding($false)))
        Write-Output "idle auto-push: ON  (takes effect immediately)"
    }
    "off" {
        $config.idleNotify = [pscustomobject]@{ enabled = $false }
        $json = $config | ConvertTo-Json -Depth 12
        [System.IO.File]::WriteAllText($configPath, $json, (New-Object System.Text.UTF8Encoding($false)))
        Write-Output "idle auto-push: OFF"
    }
    "status" {
        $state = "OFF"
        if ($config.idleNotify -is [bool]) { $state = if ($config.idleNotify) { "ON" } else { "OFF" } }
        elseif ($config.idleNotify.enabled -eq $true) { $state = "ON" }
        $target = if ($config.qqbot.notifyTarget) { "yes" } else { "no" }
        Write-Output "idle auto-push: $state"
        Write-Output "target configured: $target"
        Write-Output "config: $configPath"
    }
    "toggle" {
        $current = $false
        if ($config.idleNotify -is [bool]) { $current = $config.idleNotify }
        elseif ($config.idleNotify.enabled -eq $true) { $current = $true }
        $next = -not $current
        $config.idleNotify = [pscustomobject]@{ enabled = $next }
        $json = $config | ConvertTo-Json -Depth 12
        [System.IO.File]::WriteAllText($configPath, $json, (New-Object System.Text.UTF8Encoding($false)))
        Write-Output ("idle auto-push: " + $(if ($next) { "ON" } else { "OFF" }))
    }
    default {
        Write-Output "usage: notify-qq [on|off|status|toggle]"
        exit 2
    }
}
