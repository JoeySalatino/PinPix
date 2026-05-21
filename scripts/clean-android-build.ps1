# Wipes corrupted Gradle/React Native native build caches. Run before npm run android.
$ErrorActionPreference = "SilentlyContinue"

Write-Host "Stopping Gradle daemons..."
& "$env:USERPROFILE\.gradle\wrapper\dists" 2>$null | Out-Null
if (Test-Path "C:\Program Files\Android\Android Studio\jbr\bin\java.exe") {
  $env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
  & "$env:JAVA_HOME\bin\java.exe" -version 2>$null | Out-Null
}
$projectRoot = Split-Path $PSScriptRoot -Parent
$gradlew = Join-Path $projectRoot "android\gradlew.bat"
if (Test-Path $gradlew) {
  Push-Location (Join-Path $projectRoot "android")
  if (-not $env:JAVA_HOME) { $env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr" }
  .\gradlew.bat --stop 2>$null
  Pop-Location
}

$paths = @(
  "$env:USERPROFILE\.gradle\caches",
  "C:\gradle\caches",
  (Join-Path $projectRoot "android\.gradle"),
  (Join-Path $projectRoot "android\app\build"),
  (Join-Path $projectRoot "android\build"),
  (Join-Path $projectRoot "node_modules\expo-modules-core\android\.cxx"),
  (Join-Path $projectRoot "node_modules\react-native-worklets\android\.cxx"),
  (Join-Path $projectRoot "node_modules\react-native-screens\android\.cxx"),
  (Join-Path $projectRoot "node_modules\react-native-reanimated\android\.cxx"),
  (Join-Path $projectRoot "android\app\.cxx")
)

foreach ($p in $paths) {
  if (Test-Path $p) {
    Write-Host "Removing $p"
    Remove-Item -LiteralPath $p -Recurse -Force
  }
}

Write-Host "Done. Run: npm run android"
