@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "PHP=php"
where php >nul 2>nul
if errorlevel 1 (
  set "PHP="
  if exist "C:\xampp\php\php.exe" set "PHP=C:\xampp\php\php.exe"
  if exist "C:\laragon\bin\php" for /d %%D in ("C:\laragon\bin\php\php-8*") do if exist "%%D\php.exe" set "PHP=%%D\php.exe"
  if exist "C:\wamp64\bin\php" for /d %%D in ("C:\wamp64\bin\php\php8*") do if exist "%%D\php.exe" set "PHP=%%D\php.exe"
)
if not defined PHP (
  echo.
  echo  PHP nao encontrado.
  echo  Instale o XAMPP ^(apachefriends.org^) ou o PHP 8+ ^(windows.php.net^) e rode este arquivo de novo.
  echo.
  pause
  exit /b 1
)
set "ZIPEXT="
"%PHP%" -m | findstr /i /x "zip" >nul || set "ZIPEXT=-d extension=zip"
"%PHP%" -m | findstr /i /x "curl" >nul || set "ZIPEXT=%ZIPEXT% -d extension=curl"
"%PHP%" -m | findstr /i /x "openssl" >nul || set "ZIPEXT=%ZIPEXT% -d extension=openssl"
set "COMICSTREAM_PHP_ARGS=%ZIPEXT%"
set "HOST=127.0.0.1"
if /i "%~1"=="rede" set "HOST=0.0.0.0"
echo.
echo  ComicStream rodando em http://localhost:8080
if /i "%~1"=="rede" echo  Celular na mesma rede: http://IP-DESTE-PC:8080
echo  NAO feche esta janela enquanto estiver lendo.
echo.
start "" http://localhost:8080
"%PHP%" %ZIPEXT% -d upload_max_filesize=2G -d post_max_size=2G -d max_file_uploads=50 -d memory_limit=512M -d max_execution_time=0 -d display_errors=0 -S %HOST%:8080 -t public
pause
