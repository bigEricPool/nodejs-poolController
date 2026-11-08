# Copies the newest daily pool backup, and every full backup not copied yet, from the Pi to this Windows PC, so a copy survives the Pi's
# SD card. The daily archives here are trimmed to the newest -Keep; full backups (made by hand with pool-backup.sh) are never removed here.
#
# The Pi makes the archives itself (pool-backup.sh --daily from cron, into ~/pool-backups). This script only pulls: nothing runs on the PC as a
# server, and the PC does not need to be on when the Pi makes the backup. It uses the ssh and scp that come with Windows, with a key, so
# there is no password prompt.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File pool-backup-pull.ps1 [-PiHost poolpi] [-PiUser eric] [-Dest C:\Users\me\pool-backups] [-Keep 30]
#
# Setup, once:
#   1. A key on the PC, if there is none yet:     ssh-keygen -t ed25519
#   2. The public key onto the Pi:                type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh eric@poolpi "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
#   3. Check it needs no password:                ssh -o BatchMode=yes eric@poolpi true
#   4. Run this script once by hand, then schedule it (Task Scheduler, daily, "run as soon as possible after a scheduled start is missed").
#
# The archives hold the PoolMath share code (in poolConfig.json): keep -Dest out of OneDrive and other synced folders.
# What happened is written to pull.log in -Dest.

param(
    [string]$PiHost = 'poolpi',
    [string]$PiUser = 'eric',
    [string]$Dest = (Join-Path $env:USERPROFILE 'pool-backups'),
    [int]$Keep = 30
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path $Dest)) { New-Item -ItemType Directory -Path $Dest | Out-Null }
$log = Join-Path $Dest 'pull.log'
function Write-Log([string]$msg) {
    $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    Add-Content -Path $log -Value $line
    Write-Host $line   # not Write-Output: Copy-Archive's return value must be only its $true or $false
}

$target = '{0}@{1}' -f $PiUser, $PiHost
$sshOpts = @('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15')

# Copies one archive, given as "<size> <path>" from the Pi, unless it is already here with the same size. Returns $true when the archive is here.
function Copy-Archive([string]$line) {
    $parts = $line.Trim() -split ' ', 2
    $size = [int64]$parts[0]
    $remote = $parts[1]
    $name = Split-Path $remote -Leaf
    $local = Join-Path $Dest $name
    if ((Test-Path $local) -and ((Get-Item $local).Length -eq $size)) { Write-Log "$name is already here."; return $true }
    $tmp = "$local.part"
    if (Test-Path $tmp) { Remove-Item $tmp -Force }
    & scp -q @sshOpts ('{0}:{1}' -f $target, $remote) $tmp
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $tmp)) { Write-Log "Copying $name failed (scp exit $LASTEXITCODE)."; return $false }
    $got = (Get-Item $tmp).Length
    if ($got -ne $size) { Remove-Item $tmp -Force; Write-Log "Copying $name gave $got bytes, expected $size; not kept."; return $false }
    Move-Item -Path $tmp -Destination $local -Force
    Write-Log ('Copied {0} ({1:N1} MB).' -f $name, ($size / 1MB))
    return $true
}

# No double quotes in the commands sent to the Pi: Windows PowerShell 5.1 does not escape them when it passes an argument to ssh.exe.
# The archive names have no spaces (pool-backup.sh keeps only letters, digits, dots, dashes and underscores in them).

# The newest daily archive on the Pi, with its size: "<size> <path>".
$info = & ssh @sshOpts $target 'f=$(ls -1t ~/pool-backups/daily_*.tar.gz 2>/dev/null | head -1); test -n $f && stat -c ''%s %n'' $f'
if ($LASTEXITCODE -ne 0 -or -not $info) { Write-Log "Could not reach $target or it has no daily backup (ssh exit $LASTEXITCODE)."; exit 1 }
$ok = Copy-Archive ([string]$info)

# Every full backup on the Pi (any archive not named daily_*). They are made by hand and rarely, so each one not here yet is copied, and
# none is removed here: delete old ones yourself.
$full = & ssh @sshOpts $target 'for f in $(ls -1t ~/pool-backups/*.tar.gz 2>/dev/null); do case ${f##*/} in daily_*) ;; *) stat -c ''%s %n'' $f ;; esac; done'
if ($LASTEXITCODE -ne 0) { Write-Log "Could not list the full backups on $target (ssh exit $LASTEXITCODE)."; $ok = $false }
foreach ($line in @($full)) { if ($line -and -not (Copy-Archive ([string]$line))) { $ok = $false } }

# Keep the newest $Keep daily archives here (the names carry the date and time, so they sort by age)
$old = Get-ChildItem -Path $Dest -Filter 'daily_*.tar.gz' | Sort-Object Name -Descending | Select-Object -Skip $Keep
foreach ($f in $old) { Remove-Item $f.FullName -Force; Write-Log "Removed the old $($f.Name)." }
if ($ok) { exit 0 } else { exit 1 }
