$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "========================================"
Write-Host " DynamicMarket Build Script"
Write-Host "========================================"

# --- Locate Maven ---
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
        Write-Host "[OK] Using local Maven: $mvnExe"
        $mvnCmd = $mvnExe
    } else {
        Write-Host "[INFO] Maven not found. Downloading Maven $mvnVersion (~9MB)..."
        $zipUrl  = "https://dlcdn.apache.org/maven/maven-3/$mvnVersion/binaries/apache-maven-$mvnVersion-bin.zip"
        $zipPath = Join-Path $PSScriptRoot ".mvn-local\maven.zip"

        New-Item -ItemType Directory -Force -Path (Join-Path $PSScriptRoot ".mvn-local") | Out-Null

        try {
            Write-Host "  Downloading from: $zipUrl"
            Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -UseBasicParsing
        } catch {
            $zipUrl2 = "https://archive.apache.org/dist/maven/maven-3/$mvnVersion/binaries/apache-maven-$mvnVersion-bin.zip"
            Write-Host "  Primary failed. Trying mirror: $zipUrl2"
            Invoke-WebRequest -Uri $zipUrl2 -OutFile $zipPath -UseBasicParsing
        }

        Write-Host "  Extracting..."
        Expand-Archive -Path $zipPath -DestinationPath (Join-Path $PSScriptRoot ".mvn-local") -Force
        Remove-Item $zipPath

        if (-not (Test-Path $mvnExe)) {
            Write-Host "[ERROR] Maven extraction failed." -ForegroundColor Red
            exit 1
        }
        Write-Host "[OK] Maven $mvnVersion downloaded successfully."
        $mvnCmd = $mvnExe
    }
}

# --- Build ---
Write-Host ""
Write-Host "[1/2] Running Maven build..."
& $mvnCmd clean package "-q"
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "[ERROR] Build failed. Check the error above." -ForegroundColor Red
    exit 1
}
Write-Host "  Build successful!"

# --- Copy JAR ---
$srcJar = Join-Path $PSScriptRoot "target\DynamicMarket-1.0.0.jar"
$dstDir = Join-Path $PSScriptRoot "..\plugins"
$dstJar = Join-Path $dstDir "DynamicMarket.jar"

if (-not (Test-Path $dstDir)) {
    New-Item -ItemType Directory -Force -Path $dstDir | Out-Null
}

Write-Host "[2/2] Copying to plugins\DynamicMarket.jar..."
Copy-Item -Path $srcJar -Destination $dstJar -Force
Write-Host "  Done!"

Write-Host ""
Write-Host "========================================"
Write-Host " Build complete! plugins\DynamicMarket.jar updated."
Write-Host " Restart the server to activate the plugin."
Write-Host "========================================"
