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

# Preserve every other field; only touch awayNotify.
$config = Get-Content $configPath -Raw | ConvertFrom-Json

switch ($Action.ToLower()) {
    "on" {
        $config.awayNotify = [pscustomobject]@{ enabled = $true }
        if ($config.PSObject.Properties["idleNotify"]) { $config.PSObject.Properties.Remove("idleNotify") }
        $json = $config | ConvertTo-Json -Depth 12
        [System.IO.File]::WriteAllText($configPath, $json, (New-Object System.Text.UTF8Encoding($false)))
        Write-Output "away auto-push: ON  (takes effect immediately)"
    }
    "off" {
        $config.awayNotify = [pscustomobject]@{ enabled = $false }
        if ($config.PSObject.Properties["idleNotify"]) { $config.PSObject.Properties.Remove("idleNotify") }
        $json = $config | ConvertTo-Json -Depth 12
        [System.IO.File]::WriteAllText($configPath, $json, (New-Object System.Text.UTF8Encoding($false)))
        Write-Output "away auto-push: OFF"
    }
    "status" {
        $state = "OFF"
        if ($config.awayNotify -is [bool]) { $state = if ($config.awayNotify) { "ON" } else { "OFF" } }
        elseif ($config.awayNotify.enabled -eq $true) { $state = "ON" }
        $target = if ($config.qqbot.notifyTarget) { "yes" } else { "no" }
        Write-Output "away auto-push: $state"
        Write-Output "target configured: $target"
        Write-Output "config: $configPath"
    }
    "toggle" {
        $current = $false
        if ($config.awayNotify -is [bool]) { $current = $config.awayNotify }
        elseif ($config.awayNotify.enabled -eq $true) { $current = $true }
        $next = -not $current
        $config.awayNotify = [pscustomobject]@{ enabled = $next }
        if ($config.PSObject.Properties["idleNotify"]) { $config.PSObject.Properties.Remove("idleNotify") }
        $json = $config | ConvertTo-Json -Depth 12
        [System.IO.File]::WriteAllText($configPath, $json, (New-Object System.Text.UTF8Encoding($false)))
        Write-Output ("away auto-push: " + $(if ($next) { "ON" } else { "OFF" }))
    }
    default {
        Write-Output "usage: notify-qq [on|off|status|toggle]"
        exit 2
    }
}
