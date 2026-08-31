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

## Закрыть сайт логином и паролем

По умолчанию инстанс открыт всем. Чтобы поставить перед ним HTTP-авторизацию,
задайте в Coolify (**Environment Variables**) две переменные:

```
BASIC_AUTH_USER=alex
BASIC_AUTH_PASSWORD=длинный-пароль
```

Пароль имеет смысл пометить в Coolify как секрет. Дальше **Restart** — этого
достаточно, пересборка не нужна: пароль хешируется (`openssl passwd -apr1`)
при старте контейнера, в образ он не попадает.

Если хотя бы одна из переменных пуста, сайт остаётся публичным.

Что важно понимать про приватность: рисунки и так хранятся в localStorage
браузера, а не на сервере. Чужой человек, открывший ваш адрес, не увидит ваших
рисунков — он получит пустой холст. Авторизация нужна не для защиты рисунков, а
чтобы посторонние вообще не пользовались вашим сервером.

Ручка `/healthz` намеренно оставлена без авторизации — по ней ходит healthcheck
контейнера. Она отдаёт только строку `ok` и ничего не раскрывает.

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

## Если деплой падает

| Ошибка в логе | Причина |
| --- | --- |
| `Failed to read the Docker Compose file from the repository` | Неверный путь в **Docker Compose Location**. Нужен `/docker-compose.coolify.yml` — именно `.yml`, а не `.yaml`. После правки — **Save**, и только потом **Load Compose File**. |
| `Failed to read Git source` при нажатии **Load/Reload Compose File** | Для публичного репозитория Coolify читает файл через GitHub API без токена, лимит — 60 запросов в час на IP. Подождать или подключить GitHub App в **Sources**. На сам деплой не влияет: он делает обычный `git clone`. |
| `non-string key in services.<name>.environment: 0` | В `environment` сервиса список (`- KEY=value`). Coolify дописывает туда свои переменные словарём, и структуры смешиваются. Использовать форму словаря (`KEY: value`) либо не заводить блок вовсе. |
| Сборка обрывается без внятной ошибки, часто на `vite build` | Не хватает памяти. Нужно ~4 ГБ RAM на сборочном сервере. |

## Обновление

Coolify пересобирает образ на каждый деплой. Чтобы подтянуть новые версии
Excalidraw, обновите ветку из upstream и нажмите **Deploy**. Состояния,
которое можно потерять, на сервере нет — рисунки лежат в браузерах пользователей.
