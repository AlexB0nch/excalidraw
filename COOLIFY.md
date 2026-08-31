# Развёртывание Excalidraw в Coolify

Self-hosted Excalidraw — это статическая сборка фронтенда, которую отдаёт nginx
в одном контейнере. Никакой базы данных и никакого состояния на сервере нет:
рисунки хранятся в localStorage браузера.

В репозитории для этого есть:

| Файл | Для чего |
| --- | --- |
| `Dockerfile` | Сборка образа (node → vite build → nginx). Принимает build-аргументы `VITE_APP_*`. |
| `docker-compose.coolify.yml` | Один контейнер с приложением. Обычный вариант. |
| `docker-compose.coolify.collab.yml` | Приложение + собственный websocket-сервер `excalidraw-room` для совместного редактирования. |
| `docker-compose.yml` | Локальная разработка. В Coolify **не** использовать. |

## Вариант 1. Просто приложение

1. В Coolify: **Project → New Resource → Private Repository (или Public Repository)**,
   выбрать этот репозиторий и ветку.
2. **Build Pack: `Docker Compose`**, поле **Docker Compose Location**:
   `/docker-compose.coolify.yml`.
3. В **Domains** указать домен для сервиса `excalidraw` (например
   `https://draw.example.com`). TLS терминирует прокси самого Coolify, контейнер
   слушает только HTTP на порту 80.
4. **Deploy**.

Альтернатива без compose: **Build Pack: `Dockerfile`**, порт `80`. Тогда build-аргументы
из раздела ниже задаются в **Build Variables** (обычные Environment Variables на
этапе сборки не действуют).

Первая сборка долгая (yarn install + vite build всего монорепозитория) —
закладывайте 5–15 минут и минимум ~4 ГБ RAM на сборочном сервере. Последующие
сборки быстрее за счёт кеша yarn.

## Вариант 2. Со своим сервером совместного редактирования

Compose Location: `/docker-compose.coolify.collab.yml`.

Здесь два сервиса, каждому нужен свой домен:

- `excalidraw` → `https://draw.example.com`
- `excalidraw-room` → `https://collab.example.com`

**До первого деплоя** добавьте переменную окружения:

```
VITE_APP_WS_SERVER_URL=https://collab.example.com
```

Она вшивается в JS-бандл во время сборки, поэтому задать её нужно заранее, а при
изменении — пересобрать (**Deploy**, не **Restart**).

Что при этом остаётся на серверах Excalidraw:

- сохранение сцены комнаты (чтобы присоединившийся позже увидел рисунок) идёт
  через Firebase-проект из `VITE_APP_FIREBASE_CONFIG`;
- «Экспорт по ссылке» — через `VITE_APP_BACKEND_V2_*` (`json.excalidraw.com`);
- библиотеки фигур — через `VITE_APP_LIBRARY_*`.

Сам холст и live-сессия при этом уже полностью на вашем сервере. Чтобы убрать и
остальное, подставьте свои значения этих переменных (нужен собственный Firebase-проект
и storage-бэкенд) — все они прокинуты как build-аргументы.

## Build-аргументы

Все перечисленные ниже переменные — **времени сборки**. Vite подставляет их
значения прямо в бандл, задавать их на работающем контейнере бессмысленно.
Незаданные (пустые) переменные не переопределяют ничего: остаются значения из
`.env.production`.

| Переменная | Значение по умолчанию | Назначение |
| --- | --- | --- |
| `VITE_APP_WS_SERVER_URL` | `https://oss-collab.excalidraw.com` | Websocket-сервер совместного редактирования |
| `VITE_APP_BACKEND_V2_GET_URL` / `_POST_URL` | `https://json.excalidraw.com/api/v2/…` | Экспорт сцены по ссылке |
| `VITE_APP_FIREBASE_CONFIG` | публичный проект Excalidraw | Хранение сцены комнаты |
| `VITE_APP_LIBRARY_URL` / `VITE_APP_LIBRARY_BACKEND` | `libraries.excalidraw.com` | Библиотеки фигур |
| `VITE_APP_AI_BACKEND` | `https://oss-ai.excalidraw.com` | AI-функции (текст → диаграмма) |
| `VITE_APP_ENABLE_TRACKING` | `false` | Аналитика; в Docker-сборке выключена |

Sentry в Docker-сборке отключён (`build:app:docker` задаёт `VITE_APP_DISABLE_SENTRY=true`).

## Проверка локально

```bash
docker compose -f docker-compose.coolify.yml build
docker run --rm -p 3000:80 <image>
```

Или разово, без compose:

```bash
docker build -t excalidraw-selfhosted \
  --build-arg VITE_APP_WS_SERVER_URL=https://collab.example.com .
docker run --rm -p 3000:80 excalidraw-selfhosted
```

Приложение откроется на http://localhost:3000.

## Обновление

Coolify пересобирает образ на каждый деплой. Чтобы подтянуть новые версии
Excalidraw, обновите ветку из upstream и нажмите **Deploy**. Состояния,
которое можно потерять, на сервере нет — рисунки лежат в браузерах пользователей.
