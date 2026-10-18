# Установка MarkRead на Windows 10

Инструкция рассчитана на чистую Windows 10 (64-bit) и Discord Desktop. Плагин ставится как userplugin Vencord и требует сборки Vencord из исходников.

## 1. Что понадобится

- Discord Desktop для Windows (не Microsoft Store-версия, а установщик с discord.com).
- [Node.js 20 LTS или новее](https://nodejs.org/) с npm.
- [Git for Windows](https://git-scm.com/download/win).
- [pnpm](https://pnpm.io/installation) — менеджер пакетов Vencord.

Проверьте установку в PowerShell:

```powershell
node --version
npm --version
git --version
pnpm --version
```

Если `pnpm` не найден:

```powershell
npm install -g pnpm
```

## 2. Скачайте MarkRead

```powershell
cd $HOME\Documents
git clone <URL-вашего-форка-или-этого-репозитория> PluginMarkRead
```

Внутри появится папка `PluginMarkRead\markRead`.

## 3. Соберите Vencord с плагином

```powershell
cd $HOME\Documents
git clone https://github.com/Vendicated/Vencord.git Vencord
cd Vencord
pnpm install --frozen-lockfile
```

Скопируйте плагин в каталог пользовательских плагинов:

```powershell
# Если папки src\userplugins ещё нет, создайте её
New-Item -ItemType Directory -Force -Path src\userplugins | Out-Null
Copy-Item -Recurse -Force ..\PluginMarkRead\markRead src\userplugins\markRead
```

Проверьте структуру:

```
Vencord\src\userplugins\markRead\index.tsx
Vencord\src\userplugins\markRead\protocol.ts
Vencord\src\userplugins\markRead\core\...
```

Соберите:

```powershell
pnpm build
```

Ожидаемый результат — каталог `dist` без ошибок. При ошибке TypeScript убедитесь, что используется актуальный `main` Vencord и Node.js 20+.

## 4. Установите сборку в Discord

```powershell
pnpm inject
```

Установщик попросит выбрать установку Discord (обычная или PTB/Canary). Выберите свою и дождитесь сообщения об успехе.

Полностью закройте Discord (правый клик по иконке в трее → Quit Discord) и запустите снова.

> Если Discord обновился и Vencord «отвалился», повторите `pnpm inject` в папке `Vencord`.

## 5. Включите плагин

1. Discord → **Настройки пользователя** (шестерёнка) → **Vencord** → **Plugins**.
2. Найдите **MarkRead** и включите переключатель.
3. Нажмите на шестерёнку рядом с плагином и настройте:
   - **Receipt exchange** — включить;
   - **Relay URL** — `wss://ваш-домен/ws` (см. [`server.md`](server.md));
   - **Share read receipts** — включить, если хотите отправлять свои подтверждения;
   - при необходимости — dwell time, размер и цвет.
4. В блоке **Relay connection** нажмите **Reconnect now**. Статус должен стать **Connected**.

## 6. Проверка

1. Собеседник устанавливает MarkRead, подключается к тому же relay и включает оба переключателя.
2. Напишите ему сообщение в личку. Рядом со временем появится ✅.
3. Попросите его открыть переписку и подержать сообщение на экране 1,5–2 секунды. У вас появится ✅✅.
4. Переключитесь в другой канал до истечения dwell-времени — подтверждение не должно появиться. Это ожидаемо.

## Обновление

```powershell
cd $HOME\Documents\PluginMarkRead
git pull
Copy-Item -Recurse -Force .\markRead $HOME\Documents\Vencord\src\userplugins\markRead
cd $HOME\Documents\Vencord
pnpm build
pnpm inject
```

## Удаление

1. Выключите плагин в настройках Vencord.
2. Удалите папку `Vencord\src\userplugins\markRead`.
3. Пересоберите Vencord (`pnpm build`) и выполните `pnpm inject`.
4. При необходимости очистите данные: в панели MarkRead нажмите **Delete everything** (до удаления плагина).

## Частые проблемы

| Симптом | Причина | Решение |
| --- | --- | --- |
| Плагина нет в списке | Не скопирован в `src/userplugins` или сборка не выполнена | Проверьте путь и выполните `pnpm build` |
| «Not configured» | Пустой Relay URL | Укажите `wss://.../ws` |
| «Reconnecting» | Сервер недоступен, неверный порт, нет TLS | Проверьте `https://домен/healthz` и настройки прокси |
| «key_mismatch» | Ключ изменился после сброса идентичности | Оператор relay: `--reset-user <id>` |
| ✅✅ не появляются | Собеседник не включил отправку, не тот relay, сообщение не было видно достаточно долго | Сверьте настройки и поведение |
| Vencord не загружается после обновления Discord | Инжектор устарел | Повторите `pnpm inject` |

Дополнительно: [`../markRead/README.md`](../markRead/README.md), [`limitations.md`](limitations.md).
