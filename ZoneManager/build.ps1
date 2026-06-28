$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "========================================"
Write-Host " ZoneManager Build Script"
Write-Host "========================================"

$mvnCmd = $null
$mvnPath = Get-Command mvn -ErrorAction SilentlyContinue
if ($mvnPath) {
    $mvnCmd = "mvn"
    Write-Host "[OK] Using system Maven: $($mvnPath.Source)"
}

if (-not $mvnCmd) {
    $mvnVersion  = "3.9.9"
    $localMvnDir = Join-Path $PSScriptRoot ".mvn-local\apache-maven-$mvnVersion"
    $mvnExe      = Join-Path $localMvnDir "bin\mvn.cmd"

    if (Test-Path $mvnExe) {
        $mvnCmd = $mvnExe
        Write-Host "[OK] Using local Maven: $mvnExe"
    } else {
        Write-Host "[INFO] Downloading Maven $mvnVersion..."
        $zipUrl  = "https://dlcdn.apache.org/maven/maven-3/$mvnVersion/binaries/apache-maven-$mvnVersion-bin.zip"
        $zipPath = Join-Path $PSScriptRoot ".mvn-local\maven.zip"
        New-Item -ItemType Directory -Force -Path (Join-Path $PSScriptRoot ".mvn-local") | Out-Null
        try {
            Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -UseBasicParsing
        } catch {
            Invoke-WebRequest -Uri "https://archive.apache.org/dist/maven/maven-3/$mvnVersion/binaries/apache-maven-$mvnVersion-bin.zip" -OutFile $zipPath -UseBasicParsing
        }
        Expand-Archive -Path $zipPath -DestinationPath (Join-Path $PSScriptRoot ".mvn-local") -Force
        Remove-Item $zipPath
        $mvnCmd = $mvnExe
        Write-Host "[OK] Maven downloaded."
    }
}

Write-Host "[1/2] Building..."
& $mvnCmd clean package "-q"
if ($LASTEXITCODE -ne 0) { Write-Host "[ERROR] Build failed." -ForegroundColor Red; exit 1 }

$dst = Join-Path $PSScriptRoot "..\plugins\ZoneManager.jar"
Write-Host "[2/2] Copying to plugins\ZoneManager.jar..."
Copy-Item -Path (Join-Path $PSScriptRoot "target\ZoneManager.jar") -Destination $dst -Force

Write-Host ""
Write-Host "========================================"
Write-Host " Build complete! Restart the server."
Write-Host "========================================"
