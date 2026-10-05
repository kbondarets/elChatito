@echo off
chcp 65001 >nul
cd /d "%~dp0"

if not exist node_modules (
  echo Устанавливаю зависимости, это займёт минуту...
  call npm install
)

echo Открываю приложение в браузере через 4 секунды...
start "" powershell -NoProfile -Command "Start-Sleep -Seconds 4; Start-Process 'http://127.0.0.1:5173'"

echo Запускаю сервер и интерфейс. Чтобы остановить - закройте это окно.
call npm run dev

echo.
echo Сервер остановлен. Нажмите любую клавишу, чтобы закрыть окно.
pause >nul
