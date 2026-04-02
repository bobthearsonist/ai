# ~/AI/init.ps1 — Developer shell integrations
# Dot-sourced by PowerShell profiles
# NOTE: This is standalone tooling — not part of the AI skills/sync system.

###############################################################################
# OpenCode — local worktree build switcher
# Usage: opencode --use [list|<number>|<name>|reset]
###############################################################################

function Invoke-OpenCodeUse {
    param([string]$Command = "list")
    
    $OPENCODE_REPO = "C:\Repositories\opencode"
    $CONFIG_FILE = Join-Path $HOME ".opencode-local"
    
    # Get list of worktrees
    function Get-Worktrees {
        $worktrees = @()
        $output = git -C $OPENCODE_REPO worktree list 2>$null
        
        foreach ($line in $output) {
            # Extract path (first field)
            $parts = $line -split '\s+', 3
            $path = $parts[0]
            
            # Extract branch name from brackets
            if ($line -match '\[([^\]]+)\]') {
                $branch = $matches[1]
                $worktrees += [PSCustomObject]@{
                    Path = $path
                    Branch = $branch
                }
            }
            elseif ($line -match '\(bare\)') {
                # Skip bare repos
                continue
            }
            elseif ($line -match '\(detached HEAD\)') {
                # Handle detached HEAD gracefully
                $worktrees += [PSCustomObject]@{
                    Path = $path
                    Branch = "detached HEAD"
                }
            }
        }
        
        return $worktrees
    }
    
    # Get current selection
    function Get-Current {
        if (Test-Path $CONFIG_FILE) {
            return (Get-Content $CONFIG_FILE -Raw).Trim()
        }
        return ""
    }
    
    # Get npm version
    function Get-NpmVersion {
        $npmBin = "C:\nvm4w\nodejs\node_modules\opencode-ai\bin\opencode"
        if (Test-Path $npmBin) {
            $pkgDir = Split-Path (Split-Path $npmBin -Parent) -Parent
            $pkgJson = Join-Path $pkgDir "package.json"
            if (Test-Path $pkgJson) {
                $pkg = Get-Content $pkgJson -Raw | ConvertFrom-Json
                return $pkg.version
            }
        }
        return $null
    }
    
    # List worktrees
    function Show-Worktrees {
        $current = Get-Current
        
        Write-Host "OpenCode local build selection:"
        
        if ([string]::IsNullOrEmpty($current)) {
            $npmVer = Get-NpmVersion
            if ($npmVer) {
                Write-Host "  Current: npm release (v$npmVer)"
            } else {
                Write-Host "  Current: npm release"
            }
        } else {
            Write-Host "  Current: $current"
        }
        
        Write-Host ""
        Write-Host "Available worktrees:"
        
        $worktrees = Get-Worktrees
        $idx = 1
        foreach ($wt in $worktrees) {
            $marker = if ($wt.Path -eq $current) { "*" } else { " " }
            Write-Host ("{0}{1}) {2,-40} {3}" -f $marker, $idx, $wt.Branch, $wt.Path)
            $idx++
        }
        
        Write-Host ""
        Write-Host "Usage: opencode --use <number|name> | opencode --use reset"
    }
    
    # Select worktree by number
    function Select-ByNumber {
        param([int]$TargetNum)
        
        $worktrees = Get-Worktrees
        
        if ($TargetNum -lt 1 -or $TargetNum -gt $worktrees.Count) {
            Write-Error "Error: Invalid number $TargetNum"
            return
        }
        
        $selected = $worktrees[$TargetNum - 1]
        $selected.Path | Out-File -FilePath $CONFIG_FILE -NoNewline -Encoding utf8
        Write-Host "✓ Selected: $($selected.Branch) ($($selected.Path))" -ForegroundColor Green
    }
    
    # Select worktree by name (partial match)
    function Select-ByName {
        param([string]$TargetName)
        
        $worktrees = Get-Worktrees
        $matches = $worktrees | Where-Object { 
            $_.Branch -like "*$TargetName*" -or 
            (Split-Path $_.Path -Leaf) -like "*$TargetName*" 
        }
        
        if ($matches.Count -eq 0) {
            Write-Error "Error: No worktree found matching '$TargetName'"
            return
        }
        elseif ($matches.Count -gt 1) {
            Write-Host "Error: Multiple worktrees match '$TargetName':" -ForegroundColor Red
            foreach ($match in $matches) {
                Write-Host "  - $($match.Branch)" -ForegroundColor Red
            }
            return
        }
        else {
            $matches[0].Path | Out-File -FilePath $CONFIG_FILE -NoNewline -Encoding utf8
            Write-Host "✓ Selected: $($matches[0].Branch) ($($matches[0].Path))" -ForegroundColor Green
        }
    }
    
    # Reset to npm release
    function Reset-Selection {
        if (Test-Path $CONFIG_FILE) {
            Remove-Item $CONFIG_FILE -Force
            Write-Host "✓ Reset to npm release" -ForegroundColor Green
        } else {
            Write-Host "Already using npm release"
        }
    }
    
    # Main logic
    switch ($Command) {
        "list" {
            Show-Worktrees
        }
        "reset" {
            Reset-Selection
        }
        default {
            # Try to parse as number
            $num = 0
            if ([int]::TryParse($Command, [ref]$num)) {
                Select-ByNumber -TargetNum $num
            } else {
                Select-ByName -TargetName $Command
            }
        }
    }
}

function opencode {
    if ($args.Count -gt 0 -and $args[0] -eq '--use') {
        $useArgs = @()
        if ($args.Count -gt 1) { $useArgs = $args[1..($args.Count - 1)] }
        Invoke-OpenCodeUse @useArgs
        return
    }

    $config = Join-Path $HOME '.opencode-local'
    $mitmCert = Join-Path $HOME '.mitmproxy\mitmproxy-ca-cert.pem'

    # Determine which opencode command to run
    $runCmd = $null
    $runArgs = @()
    if (Test-Path $config) {
        $worktreePath = (Get-Content $config -Raw).Trim()
        $srcPath = Join-Path $worktreePath 'packages\opencode\src'
        if (Test-Path $srcPath) {
            Write-Host "[opencode] Using local: $worktreePath" -ForegroundColor DarkGray
            $runCmd = Join-Path $HOME '.bun\bin\bun.exe'
            $runArgs = @('run', '--cwd', (Join-Path $worktreePath 'packages\opencode'), '--conditions=browser', 'src/index.ts') + $args
        } else {
            Write-Host "[opencode] Warning: Worktree not found at $worktreePath, falling back to npm release" -ForegroundColor Yellow
            Remove-Item $config -ErrorAction SilentlyContinue
            $runCmd = 'node'
            $runArgs = @('C:\nvm4w\nodejs\node_modules\opencode-ai\bin\opencode') + $args
        }
    } else {
        $runCmd = 'node'
        $runArgs = @('C:\nvm4w\nodejs\node_modules\opencode-ai\bin\opencode') + $args
    }

    # Share one session DB across all channels (release, dev, local, etc.)
    $env:OPENCODE_DISABLE_CHANNEL_DB = 'true'

    # Check if dev container mitmproxy is running on port 8080
    $mitmRunning = $false
    try {
        $tcp = [System.Net.Sockets.TcpClient]::new()
        $tcp.Connect('localhost', 8080)
        $tcp.Close()
        $mitmRunning = $true
    } catch {
        # mitmproxy not running
    }

    if ($mitmRunning) {
        # Route through existing mitmproxy — scope env vars to this call only
        Write-Host "[opencode] Routing through context-lens mitmproxy" -ForegroundColor DarkGray
        $savedProxy = $env:https_proxy
        $savedCert = $env:SSL_CERT_FILE
        $savedNodeCa = $env:NODE_EXTRA_CA_CERTS
        try {
            $env:https_proxy = 'http://localhost:8080'
            $env:SSL_CERT_FILE = $mitmCert
            $env:NODE_EXTRA_CA_CERTS = $mitmCert
            & $runCmd @runArgs
        } finally {
            # Restore previous values (or remove if they weren't set)
            if ($null -eq $savedProxy) { Remove-Item Env:\https_proxy -ErrorAction SilentlyContinue } else { $env:https_proxy = $savedProxy }
            if ($null -eq $savedCert) { Remove-Item Env:\SSL_CERT_FILE -ErrorAction SilentlyContinue } else { $env:SSL_CERT_FILE = $savedCert }
            if ($null -eq $savedNodeCa) { Remove-Item Env:\NODE_EXTRA_CA_CERTS -ErrorAction SilentlyContinue } else { $env:NODE_EXTRA_CA_CERTS = $savedNodeCa }
        }
    } else {
        # Fall back to context-lens CLI (starts its own servers + mitmproxy)
        context-lens --no-open opencode @args
    }
}
