# Read or change the QQ notify switch from the shell.
#
#   notify-qq              -> show status
#   notify-qq on           -> enable (ping me when a turn finishes or a permission waits)
#   notify-qq off          -> disable
#   notify-qq toggle       -> flip
#   notify-qq bridge-stop  -> kill the bridge (the plugin starts one again at its next load)
#   notify-qq bridge-restart -> kill it and immediately start the current build
#
# Works while opencode is running: the plugin re-reads the config on every
# event, so the change takes effect immediately. Nothing here talks to opencode.
#
# The opencode service itself needs no management: V2 runs a background service
# that registers its own url + password, and the bridge finds it there (no
# `opencode serve`, no attach).

param(
    [Parameter(Position = 0)][string]$Action = "status"
)

$ErrorActionPreference = "Stop"

$bridgePort = if ($env:OPENCODE_NOTIFY_QQ_LOCK_PORT) { [int]$env:OPENCODE_NOTIFY_QQ_LOCK_PORT } else { 4097 }

function Stop-PortHolder([int]$Port) {
    $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    foreach ($c in $conns) { taskkill /F /PID $c.OwningProcess 2>&1 | Out-Null }
    return [bool]$conns
}

# The plugin already replaces a bridge whose source changed, but only when it
# loads. These are the manual escape hatches: `bridge-stop` kills a wedged
# daemon, `bridge-restart` kills it and immediately starts the current build.
if ($Action.ToLower() -eq "bridge-stop") {
    if (Stop-PortHolder $bridgePort) {
        Write-Output "stopped the bridge on port $bridgePort (the plugin restarts it at its next load)"
        exit 0
    }
    Write-Output "nothing listening on $bridgePort"
    exit 0
}

if ($Action.ToLower() -eq "bridge-restart") {
    # The bridge lives next to this CLI; its state and log live one level up,
    # where the plugin computes HERE (the plugin file's directory).
    $script = Join-Path $PSScriptRoot "bridge.ts"
    if (-not (Test-Path $script)) { Write-Output "bridge.ts not found at $script"; exit 1 }
    $bun = (Get-Command bun -ErrorAction SilentlyContinue).Source
    if (-not $bun) { Write-Output "bun not found on PATH; start the bridge manually"; exit 1 }

    $pluginsDir = Split-Path $PSScriptRoot -Parent
    if (Stop-PortHolder $bridgePort) { Write-Output "stopped the old bridge on port $bridgePort" }
    Start-Sleep -Milliseconds 500

    # Same environment the plugin passes, so the hash check and the state file
    # keep working (a stale hash would make the plugin replace it again).
    $env:OPENCODE_NOTIFY_QQ_BRIDGE_STATE = Join-Path $pluginsDir "bridge.state.json"
    $env:OPENCODE_NOTIFY_QQ_BRIDGE_HASH = (Get-FileHash $script -Algorithm SHA256).Hash.Substring(0, 16).ToLower()
    $log = Join-Path $pluginsDir "bridge.log"
    Start-Process -FilePath $bun -ArgumentList @("run", $script) `
        -RedirectStandardOutput $log -RedirectStandardError "$log.err" -WindowStyle Hidden | Out-Null

    Start-Sleep -Seconds 4
    Write-Output "bridge restarted from $script (lock port $bridgePort, log $log)"
    exit 0
}

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
        Write-Output "usage: notify-qq [on|off|status|toggle|bridge-stop|bridge-restart]"
        exit 2
    }
}
