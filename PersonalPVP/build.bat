@echo off
echo PersonalPVP をビルドします...
cd /d "%~dp0"

where mvn >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Maven が見つかりません。Maven をインストールして PATH に追加してください。
    pause
    exit /b 1
)

mvn clean package -q
if %ERRORLEVEL% neq 0 (
    echo [ERROR] ビルド失敗
    pause
    exit /b 1
)

echo ビルド成功！JAR を plugins フォルダにコピーします...
copy /Y "target\PersonalPVP.jar" "..\plugins\PersonalPVP.jar"
echo 完了: plugins\PersonalPVP.jar
pause
