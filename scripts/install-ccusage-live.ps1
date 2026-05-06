param(
    [string]$ProfilePath = $PROFILE.CurrentUserAllHosts,
    [switch]$InstallCcusage
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($InstallCcusage -and -not (Get-Command ccusage.cmd -ErrorAction SilentlyContinue)) {
    if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
        throw "npm is required to install ccusage. Install Node.js/npm, then rerun this script."
    }

    & npm.cmd install -g ccusage
    if ($LASTEXITCODE -ne 0) {
        throw "npm install -g ccusage failed with exit code $LASTEXITCODE."
    }
}

$profileDir = Split-Path -Path $ProfilePath -Parent
if ($profileDir) {
    New-Item -ItemType Directory -Force -Path $profileDir | Out-Null
}

$start = "# >>> ccusage-live-wrapper >>>"
$end = "# <<< ccusage-live-wrapper <<<"

$block = @'
# >>> ccusage-live-wrapper >>>
function ccusage {
    if ($args.Count -gt 0 -and $args[0] -eq "live") {
        $date = if ($args.Count -gt 1) { $args[1] } else { Get-Date -Format "yyyyMMdd" }
        $tokenLimit = 80000000
        $compactWidth = 200
        $originalColumns = $env:COLUMNS

        Write-Host -NoNewline "`e[?1049h`e[?25l"
        try {
            $time = Get-Date -Format "HH:mm:ss"
            $loading = "--- ccusage LIVE for $date ($time) ---`nLoading first refresh..."
            Write-Host -NoNewline "`e[H`e[2J"
            Write-Host $loading

            while ($true) {
                $time = Get-Date -Format "HH:mm:ss"
                $terminalWidth = $Host.UI.RawUI.WindowSize.Width
                if ($terminalWidth -lt 1) { $terminalWidth = 120 }
                $env:COLUMNS = [string]$terminalWidth

                if ($terminalWidth -lt $compactWidth) {
                    $session = (& ccusage.cmd session --since $date --compact --color 2>$null | Out-String)
                    $blocks = (& ccusage.cmd blocks --recent --token-limit $tokenLimit --compact --color 2>$null | Out-String)
                } else {
                    $session = (& ccusage.cmd session --since $date --color 2>$null | Out-String)
                    $blocks = (& ccusage.cmd blocks --recent --token-limit $tokenLimit --color 2>$null | Out-String)
                }

                if ($session -notmatch "Claude Code Token Usage Report") {
                    $session = "No session usage found since $date.`n"
                }

                $buffer = "--- ccusage LIVE for $date ($time) ---`n"
                $buffer += $session
                $buffer += "`n--- Blocks ---`n"
                $buffer += $blocks

                Write-Host -NoNewline "`e[H`e[2J"
                Write-Host $buffer -NoNewline
                Start-Sleep -Seconds 1
            }
        } finally {
            if ($null -eq $originalColumns) {
                Remove-Item Env:COLUMNS -ErrorAction SilentlyContinue
            } else {
                $env:COLUMNS = $originalColumns
            }
            Write-Host -NoNewline "`e[?25h`e[?1049l"
        }
    } else {
        & ccusage.cmd @args 2>$null
    }
}
# <<< ccusage-live-wrapper <<<
'@

$content = if (Test-Path -LiteralPath $ProfilePath) {
    Get-Content -LiteralPath $ProfilePath -Raw
} else {
    ""
}

$pattern = "(?s)$([regex]::Escape($start)).*?$([regex]::Escape($end))"
if ($content -match $pattern) {
    $content = [regex]::Replace(
        $content,
        $pattern,
        [System.Text.RegularExpressions.MatchEvaluator] { param($match) $block }
    )
} elseif ([string]::IsNullOrWhiteSpace($content)) {
    $content = $block + [Environment]::NewLine
} else {
    $content = $content.TrimEnd() + "`r`n`r`n" + $block + "`r`n"
}

Set-Content -LiteralPath $ProfilePath -Value $content -Encoding utf8

Write-Host "Installed ccusage live wrapper to $ProfilePath"
if (-not (Get-Command ccusage.cmd -ErrorAction SilentlyContinue)) {
    Write-Warning "ccusage.cmd was not found. Install it with: npm install -g ccusage"
}
Write-Host "Reload your profile with: . '$ProfilePath'"
Write-Host "Then run: ccusage live"
