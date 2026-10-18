# Развёртывание relay-сервера MarkRead

Relay — единственный сетевой компонент проекта. Он принимает WebSocket-подключения клиентов, проверяет подписи и пересылает подтверждения адресатам. Сервер не видит содержимое сообщений и не обращается к Discord API.

## Требования

- Node.js 20 или новее (рекомендуется 22 LTS).
- Домен и TLS-сертификат (Let's Encrypt). WSS обязателен: клиент откажется подключаться по `ws://`, кроме `localhost`.
- 128 МБ RAM достаточно для небольшой группы пользователей; состояние — несколько килобайт на пользователя.
- Исходящий интернет не требуется.

## Сборка и запуск

```bash
cd server
npm ci
npm run build
DATA_DIR=/var/lib/markread PORT=8787 npm start
```

Переменные окружения:

| Переменная | По умолчанию | Описание |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Адрес прослушивания. За reverse-proxy ставьте `127.0.0.1`. |
| `PORT` | `8787` | TCP-порт. |
| `DATA_DIR` | не задан | Каталог для реестра ключей и офлайн-очереди. Без него состояние теряется при перезапуске. |
| `ALLOWED_ORIGINS` | пусто | Список Origin через запятую. Пусто — проверка выключена. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`, `silent`. |
| `MAX_CONNECTIONS_PER_USER` | `5` | Одновременные сессии одного Discord ID. |
| `MAX_CONNECTIONS_TOTAL` | `10000` | Общий лимит соединений. |
| `AUTH_TIMEOUT_MS` | `10000` | Время на challenge-response. |
| `IDLE_TIMEOUT_MS` | `90000` | Отключение неактивных сокетов. |
| `MAX_FRAME_BYTES` | `16384` | Максимальный размер кадра. |
| `RECEIPT_BURST` / `RECEIPTS_PER_MINUTE` | `120` / `240` | Лимит подтверждений. |
| `WATCH_BURST` / `WATCHES_PER_MINUTE` | `60` / `60` | Лимит запросов статуса собеседника. |
| `INBOX_TTL_HOURS` | `168` | Сколько хранить подтверждение для офлайн-получателя. |
| `MAX_QUEUED_PER_USER` | `200` | Размер офлайн-очереди. |

Все параметры можно передать и флагами (`--port`, `--data-dir`, `--allowed-origins`, `--log-level`, `--reset-user`).

## Reverse proxy и TLS

### nginx

```nginx
server {
    listen 443 ssl http2;
    server_name markread.example.com;

    ssl_certificate     /etc/letsencrypt/live/markread.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/markread.example.com/privkey.pem;

    location /ws {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 120s;
    }

    location /healthz {
        proxy_pass http://127.0.0.1:8787;
        access_log off;
    }
}
```

В плагине укажите `wss://markread.example.com/ws`.

### Caddy

```caddyfile
markread.example.com {
    reverse_proxy /ws* 127.0.0.1:8787
    reverse_proxy /healthz 127.0.0.1:8787
}
```

Caddy автоматически выпускает сертификаты и поддерживает WebSocket.

## systemd

`/etc/systemd/system/markread.service`:

```ini
[Unit]
Description=MarkRead relay
After=network.target

[Service]
Type=simple
User=markread
Group=markread
WorkingDirectory=/opt/markread/server
Environment=NODE_ENV=production
Environment=HOST=127.0.0.1
Environment=PORT=8787
Environment=DATA_DIR=/var/lib/markread
Environment=LOG_LEVEL=info
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/markread

[Install]
WantedBy=multi-user.target
```

```bash
sudo useradd --system --home /var/lib/markread --shell /usr/sbin/nologin markread
sudo install -d -o markread -g markread /var/lib/markread
sudo systemctl daemon-reload
sudo systemctl enable --now markread
curl https://markread.example.com/healthz
```

## Docker (по желанию)

```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8787
CMD ["node", "dist/index.js"]
```

Запуск: `docker run -d -p 127.0.0.1:8787:8787 -v markread-data:/data -e DATA_DIR=/data markread-relay`.

## Состояние и резервные копии

При заданном `DATA_DIR` сервер атомарно пишет `markread-state.json` (права `0600`). В файле:

- реестр `Discord ID → публичный ключ + отпечаток` (TOFU);
- офлайн-очередь подтверждений.

Содержимое сообщений, токены Discord и IP-адреса не сохраняются. Для резервной копии достаточно скопировать файл; для сброса — остановить сервис и удалить файл.

## Администрирование

Сбросить регистрацию пользователя (например, после переустановки клиента или ошибки `key_mismatch`):

```bash
sudo -u markread env DATA_DIR=/var/lib/markread node dist/index.js --reset-user 123456789012345678
```

Команда удаляет ключ и офлайн-очередь пользователя и завершается. Сервис можно не останавливать, но при запущенном сервисе изменения в памяти будут перезаписаны при следующем сохранении, поэтому надёжнее остановить его:

```bash
sudo systemctl stop markread
sudo -u markread env DATA_DIR=/var/lib/markread node dist/index.js --reset-user 123456789012345678
sudo systemctl start markread
```

Мониторинг: `GET /healthz` возвращает JSON с версией протокола, числом соединений и зарегистрированных пользователей.

## Обновление

```bash
cd /opt/markread/server
git pull            # или распакуйте новый релиз
npm ci
npm run build
sudo systemctl restart markread
```

Протокол версионирован. Сервер v1 совместим с клиентами v1; при несовпадении версии клиент получает `unsupported_protocol` и не пытается переподключаться бесконечно.

## Проверка вручную

```bash
curl -s https://markread.example.com/healthz
# {"ok":true,"version":"1.0.0","protocol":1,...}
```

Для локальной разработки без TLS разрешён `ws://localhost:8787` — клиент принимает незашифрованный транспорт только для loopback-адресов.

## Безопасность эксплуатации

- Не публикуйте relay по HTTP: без TLS подпись и метаданные видны в сети.
- Ограничьте `ALLOWED_ORIGINS`, если клиенты всегда работают из Discord Desktop (`https://discord.com`); это не заменяет аутентификацию, но снижает поверхность атак из браузера.
- Держите Node.js в актуальном состоянии.
- Не отключайте проверку подписи и не увеличивайте лимиты без необходимости.
- Помните: relay видит метаданные (Discord ID, device id, IP, id каналов и сообщений). Если это неприемлемо, поднимите собственный сервер только для своей группы.
