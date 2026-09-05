# ПЛАН A (v2): Node-lite — JS-шимы Node, без эмуляции CPU

Собственный in-browser Node/npm-рантайм вместо `@webcontainer/api`, построенный на JS-шимах Node core-модулей и выполнении в обычном Web Worker. **Никакой эмуляции процессора** — это прямая противоположность Плану Б (v86), где CPU эмулируется по-настоящему и поэтому медленно, но зато совместимо почти со всем. Здесь наоборот: быстро, но принципиально не совместимо с нативным кодом.

## Контекст

`@webcontainer/api` (StackBlitz) — закрытый рантайм, для коммерческого прод-использования нужна платная лицензия у StackBlitz (бесплатно только для open source/прототипов). Полный клон нереален — годы инженерной работы закрытой команды. Строим осознанно урезанный "Node-lite" — только чистый JS/npm (без нативных C++/node-gyp зависимостей — то же ограничение, что и у самого WebContainer, и у Nodebox/Nodepod), с реальным `npm install` из registry.npmjs.org.

Реализация — **отдельный pnpm-монорепозиторий** (второй, отдельный от v86-linux), без зависимостей от Polaris.

### Приоритеты этой версии плана (явно заданы для v2)

1. **Скорость загрузки и установки — главный критерий.** Это ровно то, чего не может дать План Б (v86): там холодный boot ~43с, здесь счёт должен идти на миллисекунды/секунды старта и на секунды (не минуты) на `npm install` типичного проекта.
2. **Без нативных модулей — осознанное, постоянное, документированное ограничение**, а не временный недочёт. В отличие от v86 (где нативные модули работают, если собраны под 32-бит — см. `v86-linux/STATUS.md` про Rollup), здесь нативный код **не будет работать никогда**, ни при каких обстоятельствах — в Worker нет реального процессора для него. Это надо явно закладывать в архитектуру `bundler`/`registry` с первого дня (см. ниже "форсировать WASM-сборки заранее"), а не обнаруживать через падения в рантайме, как это произошло в Плане Б.
3. **v1 = HTTP-сервер + Express и подобные фреймворки.** Это ядро первой поставки — то, что мы уже подтвердили работающим у альтернативных open-source реализаций (Nodepod, Nodebox) и что реально нужно для большинства бэкенд-сценариев без баз данных с нативными драйверами.
4. **Vite — отдельный план ниже, без реализации в этой фазе.** Слишком рискованно смешивать с ядром v1; вынесен в отдельный раздел с учётом ошибок, найденных в Плане Б.

### Лицензионные ограничения на заимствование (важно, разбирались отдельно)

Пользователь разрешил опираться на решения/файлы из трёх реальных проектов. Их лицензии принципиально разные, и это определяет, что можно **буквально копировать/адаптировать код**, а что — только **изучать архитектуру по документации**:

| Проект                                                                    | Лицензия                                                                                                      | Что можно делать                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`R1ck404/Nodepod`](https://github.com/R1ck404/Nodepod)                   | MIT + Commons Clause                                                                                          | **Можно копировать/адаптировать код.** Commons Clause запрещает только продажу/хостинг как конкурирующего коммерческого сервиса — обычное использование внутри своего продукта не ограничено. Самый безопасный источник кода из трёх.                                                                                                                                                                                                                                                                                                                                                                                 |
| [`Sandpack/nodebox-runtime`](https://github.com/Sandpack/nodebox-runtime) | Кастомная "Sustainable Use License" (не OSI-открытая, но точный текст мягче, чем казалось по обрывкам поиска) | **Можно копировать/адаптировать код** — точная формулировка: "for your own internal business purposes or for non-commercial or personal use". Запрещена именно **продажа/раздача самого кода как отдельного продукта третьим лицам** ("distribute... only if free of charge for non-commercial purposes"), а не использование внутри своего продукта. Обязательно: сохранять уведомления об авторстве/лицензии в скопированных файлах, и если файл изменён — явно пометить, что он изменён (условие лицензии). Есть отдельный пункт про патенты: если предъявите патентный иск к софту — лицензия сразу аннулируется. |
| `@webcontainer/api` (StackBlitz)                                          | Полностью проприетарный, исходники закрыты                                                                    | **Нет доступа к коду вообще** — не GitHub-репозиторий, нечего заимствовать. Публичные блог-посты/документация StackBlitz о своей архитектуре ("virtualized TCP network stack... mapped to ServiceWorker API") — легитимный источник идей, раз это опубликовано ими самими как объяснение подхода.                                                                                                                                                                                                                                                                                                                     |

**Рекомендация:** ядро `network`/`worker`/`shims` пакетов проектировать с оглядкой на архитектуру всех трёх, но при реальном заимствовании кода — тянуть конкретные файлы только из Nodepod и Nodebox, и то с проверкой, что переносимый файл не тянет за собой зависимости с более строгой лицензией.

## Что подтверждено исследованием

- Реальные библиотеки-кирпичики (все существуют, MIT/BSD): `path-browserify`, `stream-browserify`, `buffer`, `process/browser` (те же шимы, что десятилетиями использует webpack/browserify); `esbuild-wasm` (тот же движок, что использует Sandpack от CodeSandbox); `pako` (gunzip в браузере); `semver`.
- **Nodepod** (открыт для заимствования, см. таблицу лицензий выше) уже реализует ровно то, что нужно для v1: реальная виртуальная ФС (`fs` API целиком — read/write/watch/streams/symlinks/glob), резолвер модулей (`require()`/`import`/`package.json`), установка пакетов из настоящего npm registry, HTTP-серверы (Express/Hono/Elysia/Vite заявлены рабочими), свой bash-подобный shell (35+ команд), модель процессов на Web Worker'ах, интеграция с xterm.js. Это готовая референс-реализация почти всего, что описано в структуре монорепо ниже — при работе над `packages/vfs`, `packages/shims`, `packages/worker` в первую очередь смотреть туда.
- **Nodebox** (CodeSandbox) — рабочий пример именно того паттерна, который нужен для HTTP: "HTTP server simulation in Nodebox is managed through iframes and service workers", WebSocket — через mock-объект. Подтверждённое реальное ограничение той же архитектуры: **сырых TCP-сокетов нет и не будет** — драйверы БД с нативным протоколом (Postgres/MySQL/MongoDB) не заработают никогда. Это тот же компромисс, который придётся принять и здесь.
- Готового "npm-клиента для браузера" в природе не существует как отдельной переиспользуемой библиотеки — самая рискованная, полностью самописная часть (хотя Nodepod уже решил эту задачу для себя — см. лицензионную оговорку выше).
- Service Worker `fetch`-перехват — стандартный веб-API, тот же фундаментальный трюк, что в блоге StackBlitz.
- **Нативные бинарники — не "риск", а гарантированный сбой by design.** В Плане Б (v86) мы обнаружили это только в рантайме (Rollup падает, потому что у него нет 32-битной сборки под нашу эмулируемую архитектуру) — там это частный случай, который _иногда_ можно обойти (WASM-fallback), потому что процессор настоящий и в принципе МОГ БЫ выполнить 64-битный нативный код на другой конфигурации. Здесь — принципиально другая ситуация: **никакой нативный `.node`-биндинг не заработает никогда**, потому что нет реального процессора вообще, есть только Worker с JS/WASM. Значит принудительная замена на WASM-сборку для известных проблемных пакетов (Rollup → `@rollup/wasm-node`, esbuild → `esbuild-wasm`, будущий SWC → `@next/swc-wasm-nodejs`) нужно закладывать **проактивно в `registry`/`install.ts` с первого дня** (например, через встроенный список `overrides` по умолчанию для известных пакетов), а не находить через падения в проде, как это произошло с Vite в Плане Б.

## Структура монорепозитория

```
node-lite/                        # отдельный git-репозиторий
  pnpm-workspace.yaml
  package.json
  tsconfig.base.json

  packages/
    vfs/                          # виртуальная ФС
      src/memory-fs.ts            # Map<path, content>, fs.promises-shaped API
      src/idb-persist.ts          # IndexedDB-кэш node_modules (content-addressed по name@version)
      tests/
      package.json                # "@node-lite/vfs"

    shims/                        # Node core module shims — точный список см. "Минимальный набор
                                   # Node builtins" ниже (проверено реальным сканом дерева
                                   # зависимостей Express, не предположение)
      src/{path,stream,buffer,process,events,url,querystring,string_decoder,assert}.ts
                                   # ГОТОВЫЕ библиотеки (реэкспорт как есть, не переписываем):
                                   # path-browserify/stream-browserify/buffer/process/browser/events/
                                   # url/querystring-es3/string_decoder/assert — все зрелые
                                   # browserify/webpack-полифиллы
      src/crypto.ts                # ГОТОВАЯ библиотека crypto-browserify как основа, НО требует
                                   # отдельного решения по sync/async: Node's crypto — синхронный
                                   # API (`createHash('sha1').update(x).digest('hex')`), браузерный
                                   # Web Crypto (`crypto.subtle`) — асинхронный. crypto-browserify
                                   # уже решает это (чистый JS, без Web Crypto), но производительность
                                   # ниже нативного — принять как компромисс, не оптимизировать в v1
      src/zlib.ts                 # Обёртка вокруг уже запланированного `pako` (тот же паттерн, что
                                   # `browserify-zlib`) — нужен реально: body-parser (зависимость
                                   # Express) распаковывает gzip/deflate тела запросов
      src/tty.ts                  # Тривиальный стаб: `isatty() => false` — `debug`-пакет (зависимость
                                   # Express) только проверяет это для решения красить ли вывод
      src/net.ts                  # Тривиальный стаб: реально нужен только `net.isIP()` (проверено —
                                   # Express использует только эту функцию, чистая проверка строки
                                   # regex-ом) — НЕ полноценный net-модуль, сокеты не нужны
      src/fs.ts                   # АДАПТАЦИЯ из Nodepod (лицензия позволяет, см. таблицу выше) —
                                   # готовой отдельной библиотеки fs-API поверх виртуальной ФС не
                                   # существует, но Nodepod уже реализовал полный API (read/write/
                                   # watch/streams/symlinks/glob) поверх своей vfs; переиспользуем
                                   # их подход вместо написания с нуля
      src/http.ts                 # АДАПТАЦИЯ из Nodepod — та же логика: у них уже есть рабочий
                                   # http.createServer, прогоняющий Express/Hono/Vite; наш http.ts ->
                                   # @node-lite/network адаптирует их схему, не изобретает свою
      src/ws.ts                   # Не нужен в v1 — только в рамках отдельного плана Vite. Когда
                                   # дойдёт до реализации: АДАПТАЦИЯ из Nodebox ("mock WebSocket
                                   # object" — их подход к WebSocket) допустима по их лицензии
                                   # (см. таблицу выше), либо писать самим по этому же образцу
      # НЕ нужны для Express-класса сценариев (проверено сканом, не предположение):
      # https (в дереве Express — только текст комментария-примера, не настоящий require()),
      # async_hooks (обёрнут вызывающим кодом в try/catch с fallback на {}),
      # os, module (не встретились ни разу во всём дереве зависимостей Express)
      tests/
      package.json                # "@node-lite/shims"

    registry/                     # npm-клиент против настоящего registry.npmjs.org
      src/fetch-metadata.ts       # GET https://registry.npmjs.org/{package} с заголовком
                                   # Accept: application/vnd.npm.install-v1+json (сокращённый
                                   # packument — подтверждённый реальный пример: для пакета npm
                                   # полные метаданные 410KB, сокращённые 21KB, разница ~20x).
                                   # Tarball URL берётся из dist.tarball сокращённого packument-а,
                                   # форма https://registry.npmjs.org/<name>/-/<name>-<version>.tgz
      src/semver-resolve.ts       # deps: semver
      src/resolve-tree.ts         # без hoisting (nested-only в v1), graceful-skip optionalDependencies
      src/native-binary-overrides.ts  # встроенный список форс-замен на WASM-сборки для известных
                                       # пакетов (rollup, esbuild, ...) — применяется ВСЕГДА, не по
                                       # запросу; см. "форсировать WASM-сборки заранее" выше
      src/tarball.ts              # pako + tar-парсинг
      src/lockfile.ts             # ЦЕЛЬ: полная двусторонняя совместимость с package-lock.json
                                   # lockfileVersion 3 (актуальный формат, npm v9+, обратно
                                   # совместим с v7+) — под будущий импорт/экспорт целых проектов,
                                   # не только ускорение установки.
                                   # Читаем: name, version, lockfileVersion:3, packages{} (ключи —
                                   # относительные пути, корень — "", зависимости —
                                   # "node_modules/x"; per-entry: version/resolved/integrity/
                                   # dependencies/optionalDependencies/dev/optional/devOptional/
                                   # engines/bin/license) — resolved+integrity напрямую, без
                                   # повторного semver-резолва.
                                   # Пишем: тот же lockfileVersion:3 packages{}-формат с тем же
                                   # набором полей, чтобы сгенерированный у нас lock-файл можно было
                                   # без изменений использовать в настоящем npm install на другой
                                   # машине (реальный round-trip, не приблизительная имитация).
                                   # Fallback (лока нет / резолвим новую зависимость) —
                                   # semver-resolve.ts. yarn.lock/pnpm-lock.yaml — вне v1 (другие
                                   # форматы, другая раскладка node_modules)
      src/install.ts              # оркестратор
      tests/unit/ и tests/integration/ (реальная сеть, отдельный test:integration скрипт)
      package.json                # "@node-lite/registry"

    bundler/                      # esbuild-wasm обёртка
      src/esbuild-setup.ts
      src/vfs-plugin.ts           # onResolve/onLoad поверх vfs + shims + node_modules
      src/bundle-entry.ts
      tests/
      package.json                # "@node-lite/bundler"

    worker/                       # исполнение бандла
      src/server-worker.ts
      src/worker-host.ts          # postMessage-протокол, lifecycle
      tests/                      # реальный браузер (vitest browser mode / Playwright), не jsdom
      package.json                # "@node-lite/worker"

    network/                      # Service Worker мост
      src/service-worker.ts       # компилируется в отдельный статический JS-файл
      src/sw-bridge.ts
      src/http-emulation.ts
      tests/                      # только реальный браузер
      package.json                # "@node-lite/network"

    runtime/                      # публичный API, фреймворк-агностичный
      src/runtime.ts              # boot()/install()/run()/restart()/writeFile()
      src/types.ts
      tests/
      package.json                # "@node-lite/runtime"

  examples/
    minimal/                      # монтирует package.json+server.js без зависимостей, install->run->iframe
    express-example/              # реальный `npm install express`, реальный HTTP-ответ — основная
                                   # цель v1, зеркалит уже подтверждённый в Плане Б сценарий
                                   # (v86-linux/examples/express-example), но без CPU-эмуляции

  e2e/                            # Playwright, гоняет examples/* в реальном браузере

  docs/
    vite-plan.md                  # ОТДЕЛЬНЫЙ план для Vite — см. раздел ниже. Только планирование,
                                   # реализация вне скоупа v1.
```

**Тестовый стек**: `vitest` для чистой TS-логики (node-окружение), Playwright/`vitest browser mode` для всего browser-only (`worker`, `network` — jsdom не подходит).

## Публичные API-контракты (черновые типы)

Зафиксированы заранее, чтобы у каждого пакета был чёткий минимальный контракт до начала реализации — не просто описание словами.

```ts
// packages/runtime/src/types.ts
interface RuntimeConfig {
  previewHost: string; // wildcard-домен для превью, см. "Схема проброса превью" в Phase 0, напр. "*.preview.example.dev"
}

interface InstallResult {
  exitCode: number;
  output: string;      // объединённый stdout+stderr
  durationMs: number;  // явно фиксируем — ключевая метрика всего плана
}

interface RunResult {
  port: number;
  previewUrl: string;  // готовый URL, построенный NetworkBridge.previewUrlFor(port)
}

interface Runtime {
  boot(config: RuntimeConfig): Promise<void>;
  install(cwd?: string): Promise<InstallResult>;
  run(command: string): Promise<RunResult>;
  restart(): Promise<void>;
  writeFile(path: string, contents: Uint8Array | string): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  destroy(): Promise<void>;
}
```

```ts
// packages/vfs/src/types.ts
interface Stat {
  isDirectory(): boolean;
  isFile(): boolean;
  size: number;
  mtimeMs: number;
}

interface Vfs {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<Stat>;
  watch(path: string, cb: (event: "change" | "rename", filename: string) => void): () => void; // возвращает unsubscribe
}
```

```ts
// packages/worker/src/types.ts
interface WorkerRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: Uint8Array;
}
interface WorkerResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

interface WorkerHost {
  start(entryModule: string): Promise<void>;
  stop(): Promise<void>;
  request(req: WorkerRequest): Promise<WorkerResponse>;
}
```

```ts
// packages/network/src/types.ts
interface NetworkBridge {
  registerServer(port: number, handler: (req: Request) => Promise<Response>): void;
  unregisterServer(port: number): void;
  routeRequest(port: number, req: Request): Promise<Response>;
  previewUrlFor(port: number): string;
}
```

## Декомпозиция крупных задач (issue-sized deliverables)

Несколько формулировок из структуры выше слишком крупные, чтобы быть одной задачей — разбиты на последовательные, каждая со своим acceptance-критерием.

**"Адаптация Nodepod `fs`/`http`"** →
1. Аудит API-поверхности Nodepod (`fs.ts`/`http.ts`) — таблица покрытия методов, явно решить что портируем в v1 / что откладываем.
2. Портировать `fs`: `readFile`/`writeFile`/`readdir`/`stat` (минимум, нужный для `http.createServer`+Express). Acceptance: юнит-тесты на этих 4 методах на реальных сценариях (создать файл → прочитать → list dir → stat).
3. Портировать `fs.watch` + streams. Acceptance: отдельный тест на `createReadStream`/`createWriteStream`.
4. Symlinks/glob — явно отложено за пределы MVP (Express их не требует); пометить как открытый пункт, не потерянный.

**"Полная двусторонняя совместимость package-lock v3"** →
1. Reader (только чтение): парсинг `packages{}` во внутреннее дерево. Acceptance: unit-тесты на 2-3 реальных лок-файлах (взятых из `express`- и `vite`-проектов).
2. Writer: генерация валидного v3. Acceptance: сгенерированный файл проходит `npm install --package-lock-only --dry-run` на хосте без ошибок — это и есть проверка реального round-trip, не "похоже на v3".
3. Интеграция с резолвером как fallback-триггер (лок отсутствует/неполный → `semver-resolve.ts`).

**"Registry install orchestrator"** →
1. Установка одного пакета без зависимостей. Acceptance: `left-pad`-класса пакет реально лежит в vfs.
2. Транзитивные зависимости. Acceptance: `express` (68 пакетов) — все резолвятся и лежат в vfs.
3. Dedup/conflict handling. Acceptance: конкретный тест-кейс — два пакета, зависящие от разных версий одной библиотеки.
4. Integrity-проверка. Acceptance: намеренно битый tarball → явная ошибка, не тихий пропуск.
5. IndexedDB-кэш. Acceptance: повторная установка того же пакета не делает сетевой запрос (проверяется network-spy в тесте).

**"Service Worker bridge"** →
1. SW регистрируется, простой fetch passthrough без роутинга. Acceptance: `navigator.serviceWorker.controller` не null.
2. Роутинг одного зарегистрированного сервера. Acceptance: iframe получает синтетический `Response`.
3. Несколько серверов/портов одновременно. Acceptance: 2 iframe на разных портах не путают ответы.
4. Lifecycle (unregister/update/reload) — см. отдельный чеклист в Phase 0.

## Минимальный набор Node builtins для Express-класса сценариев

Не предположение — реальный скан: `npm install express` локально, рекурсивный проход по всем `.js`-файлам в `node_modules` (68 пакетов, всё дерево зависимостей), поиск `require('X')`/`require('node:X')` по списку `require('module').builtinModules`. Методика и скрипт воспроизводимы (см. историю — тот же подход можно прогнать на любом другом npm-пакете перед тем, как проектировать под него шимы).

| Модуль | Нужен? | Как используется / чем закрывается |
|---|---|---|
| `path`, `util`, `buffer`, `stream` | да | готовые browserify-полифиллы |
| `fs`, `http` | да | адаптация Nodepod |
| `events` | да | Express наследуется от `EventEmitter` — готовый пакет `events` |
| `crypto` | да | `cookie-signature`/`etag` — готовый `crypto-browserify`, но синхронный API vs асинхронный Web Crypto — трение, компромисс по производительности принят осознанно |
| `url`, `querystring`, `string_decoder`, `assert` | да | готовые browserify-полифиллы |
| `zlib` | да | `body-parser` реально распаковывает gzip/deflate тела запросов — обёртка вокруг `pako` |
| `tty` | да, тривиально | `debug`-пакет только спрашивает `isTTY` — стаб `isatty() => false` |
| `net` | да, тривиально | Express использует **только** `net.isIP()` (проверено — `express/lib/request.js:17`) — regex-проверка строки, не нужен реальный net-модуль |
| `https` | **нет** | совпадение было из комментария-примера в коде (`express/lib/application.js:587`), не настоящий `require()` |
| `async_hooks` | **нет** | обёрнут в `on-finished`/`raw-body` в `try { require('async_hooks') } catch (e) { return {} }` — вызывающий код уже готов к отсутствию |
| `os`, `module` | нет | не встретились ни разу во всём дереве зависимостей Express |

**Важная оговорка:** это данные под конкретно Express + его прямые/транзитивные зависимости на момент проверки. Любой ДРУГОЙ фреймворк (Koa/Fastify/Hono) или обновление версий Express может добавить новые `require()` — тот же скрипт стоит гонять как gate перед объявлением поддержки нового фреймворка, а не полагаться на этот список бессрочно.

## Фазы

**Phase -1 — Скаффолдинг.** `pnpm-workspace.yaml`, пустые пакеты-заглушки, `examples/minimal` как пустой каркас. Проверка: `pnpm install && pnpm test` проходит.

**Phase 0 — Спайк: SW network bridge.** Доказать, что обработчик обслуживается через Service Worker так, что `examples/minimal`'s iframe получает синтетический ответ — без бандлера/registry. Тесты в `e2e/` через Playwright, кросс-браузерно.

**Схема проброса превью (URL/port/previewUrl) — решается здесь, не откладывается на потом.** Выбор: **поддомен на порт**, `<port>.preview.<domain>` — та же схема, что у StackBlitz/CodeSandbox (и концептуально то же, что `<port>.external` у v86's fetch-backend в Плане Б). Не префикс пути (`/preview/<port>/...`) — префикс ломает относительные URL внутри гостевого приложения (оно не ожидает жить не в корне `/`) и рискует коллизией с реальными роутами приложения-хоста. Требует wildcard DNS + wildcard TLS-сертификат — реальная инфраструктурная зависимость (аналог relay-сервера в Плане Б), фиксируется как таковая, не как "мелкая деталь". `NetworkBridge.previewUrlFor(port)` строит именно такой URL.

**Ограничения/gates SW+iframe — проверяются как отдельные пункты, не одним общим тестом:**
- Secure context: HTTPS или `localhost` — на обычном HTTP с реальным доменом SW не зарегистрируется вообще.
- Same-origin между страницей, регистрирующей SW, и iframe, который она обслуживает.
- Scope/`Service-Worker-Allowed`: раз превью на отдельном поддомене — SW регистрируется в scope именно этого поддомена, не родительского origin.
- Race SW registration ↔ iframe navigation: `iframe.src` не выставлять, пока `navigator.serviceWorker.ready` не резолвился И controller не назначен именно для нужного scope — иначе первая навигация уходит мимо SW необслуженной.

**Go/no-go по WebKit (Safari) — конкретный чеклист, не бинарная формулировка "тянет/не тянет":**
1. SW регистрируется на iOS Safari/WebKit без ошибки.
2. `fetch`-event срабатывает для sub-resource запросов внутри scope.
3. `fetch`-event срабатывает для **top-level navigation** запроса iframe (исторически самое хрупкое место в WebKit — именно здесь наиболее вероятен сбой).
4. Синтетический `Response`, отданный из SW, реально долетает до iframe как настоящий документ.

Если 1-2 проходят, а 3-4 нет — fallback конкретный, не общий "Chromium-only": `iframe.src="about:blank"` + `document.write()`-инъекция бандла напрямую (SW используется только для sub-resource внутри уже загруженного документа, без реальной SW-навигации верхнего уровня). Если и это не работает на проверенной версии WebKit — тогда действительно Chromium-only на v1, с фиксацией номера версии WebKit, на которой проверяли (не абстрактное "Safari не тянет").

**Lifecycle-тесты — обязательная часть Phase 0, не факультативная:**
- Unregister → re-register SW → повторная навигация iframe: подтвердить, что роутинг восстанавливается.
- SW update (новая версия скрипта): явно протестировать `skipWaiting()`+`clients.claim()`, не полагаться на дефолтное поведение браузера (без форсирования обновление вступает в силу только после закрытия всех вкладок).
- Несколько iframe одновременно, каждый на своём порте/поддомене: подтвердить отсутствие cross-talk (ответ для порта A не долетает до iframe порта B).
- Явный race-тест: навигация iframe сразу после `register()`, без ожидания `ready` — задокументировать фактическое поведение (блокируется/теряется/восстанавливается самостоятельно), не оставлять неопределённым.

**Phase 1 — vfs + shims + bundler + worker (без registry).** Голый `http.createServer` без зависимостей проходит весь путь: mount → bundle → Worker → SW-мост → iframe. Юнит-тесты `memory-fs.ts` + e2e.

**Phase 2 — registry (реальный npm install) + Express.** Самая большая и рискованная фаза плана — специально раздроблена на узкие под-фазы, каждая со своим acceptance-критерием, вместо одной формулировки на десяток независимых задач. Каждая под-фаза мержится отдельно; переход к следующей — только после закрытия предыдущей.

- **Phase 2.0 — CORS-спайк (go/no-go, ничего больше).** Проверить напрямую из реального браузера (не Node): (а) `fetch()` к `https://registry.npmjs.org/{package}` с заголовком `Accept: application/vnd.npm.install-v1+json` — доступен без CORS-блокировки; (б) `fetch()` к URL тарболла (может быть другой origin/CDN с другой CORS-политикой — проверять отдельно, не считать само собой разумеющимся, что раз (а) прошло, то и (б) пройдёт). Acceptance: оба запроса успешны хотя бы в одном целевом браузере. Если заблокировано — pluggable proxy-fetcher (без хардкода на бэкенд), решается здесь, не постфактум.
- **Phase 2.1 — Один пакет, точная версия, без резолва.** Скачать конкретный `name@x.y.z` (без semver-диапазона), распаковать tarball (`pako`+tar-парсер) в vfs. Acceptance: содержимое файлов в vfs побайтово совпадает с тем, что кладёт настоящий `npm install left-pad`-класса пакета.
- **Phase 2.2 — Semver-резолв одного пакета.** Диапазон (`^1.0.0`) → конкретная версия по сокращённому packument-у (dist-tags/versions). Всё ещё один пакет, без дерева зависимостей. Acceptance: резолвится та же версия, что выбрал бы настоящий `npm install`.
- **Phase 2.3 — Дерево транзитивных зависимостей.** Комбинация 2.1+2.2 для дерева пакетов, без hoisting (nested-only). Acceptance: пакет с 2-3 уровнями транзитивных зависимостей — все файлы на месте в vfs.
- **Phase 2.4 — Integrity-проверка.** См. acceptance в "Декомпозиция крупных задач" выше (намеренно битый tarball → явная ошибка).
- **Phase 2.5 — Lockfile v3 read/write.** См. отдельную декомпозицию в "Декомпозиция крупных задач" выше (reader → writer → round-trip через `npm install --package-lock-only --dry-run`).
- **Phase 2.6 — IndexedDB-кэш по content-hash.** Acceptance: повторная установка того же `name@version` не делает сетевого запроса (network-spy в тесте).
- **Phase 2.7 — `native-binary-overrides` — инфраструктура, не полноценный тест на v1.** Express и его 68 зависимостей — **чистый JS, без единой нативной/`optionalDependencies`-зависимости** (проверено тем же сканом, что и builtins-таблица выше) — то есть механизм форс-замены на WASM у Phase 2 нечем реально проверить. Строится как инфраструктура для отдельного плана Vite (где Rollup — первый реальный кейс), здесь — только unit-тест на синтетическом примере (фейковый пакет с фейковой native-зависимостью в списке overrides).
- **Phase 2.8 — Graceful-skip сбойных `optionalDependencies`.** Отдельный тестовый пакет с намеренно неустанавливаемой опциональной зависимостью. Acceptance: основная установка всё равно завершается успешно, приложение запускается.
- **Phase 2.9 — Express e2e (финальная цель этой версии плана).** Всё вместе: `examples/express-example` — реальный `npm install express`, реальный `server.js`, реальный HTTP-ответ через SW-мост в iframe. Замерить и задокументировать время установки — ключевая метрика, ради которой существует весь План A.

Без lifecycle-скриптов (`postinstall` не запускаем) — во всех под-фазах, не только в финальной.

**Phase 3 — Документация ограничений + публикация пакетов.** `docs/limitations.md`: таблица совместимости (plain Node — да; Express/Koa/Fastify/Hono-класс фреймворков — да; нативные зависимости — никогда, не только "пока нет"; Vite — см. отдельный план ниже, не реализовано в этой версии; Next.js/CRA/другие тяжёлые CLI — не рассматривались).

**(Отдельно, вне монорепо) — интеграция в Polaris**, если потребуется: `use-webcontainer.ts` переписывается изнутри, контракт (`status/previewUrl/error/restart/terminalOutput`) не меняется.

## Отдельный план: Vite (только планирование, реализация — вне скоупа v1)

Vite реализуется **отдельной последующей фазой/веткой**, не в рамках Phase 0-3 выше. Ниже — план с учётом конкретных ошибок, реально найденных при попытке завести Vite в Плане Б (v86, см. `v86-linux/examples/vite-example/HMR-LIVE-EDIT.md` и `v86-linux/STATUS.md`).

### Уроки из Плана Б, которые обязательны к учёту здесь

1. **Не открывать через `npm create vite@latest` программно.** В Плане Б это упало с `TypeError: cursorTo ... Received NaN` внутри `readline.Interface.prompt()` — гостевая псевдо-консоль репортила себя как TTY без нормальных размеров, и Node's readline не смог посчитать позицию курсора. В Worker-окружении Node-lite **реального TTY нет вообще** — тот же класс сбоя почти гарантирован при попытке провести пользователя через интерактивный CLI create-vite. **Решение, заложенное сразу:** писать файлы шаблона Vite-проекта напрямую через `@node-lite/vfs` (package.json, index.html, main.js) — так же, как в итоге пришлось сделать и в Плане Б после того, как интерактивный путь не удалось починить.
2. **Форсировать WASM-сборку Rollup с первого дня, а не находить проблему в рантайме.** В Плане Б потратили огромное время на диагностику падения `native.js` у Rollup из-за отсутствия 32-битной сборки, затем на то, что `npm overrides` не применялся из-за устаревшей версии npm внутри гостя. Здесь: нативный код не заработает _в принципе_ (см. раздел "Что подтверждено" выше) — значит `@node-lite/registry`'s `native-binary-overrides.ts` должен **всегда** подставлять `@rollup/wasm-node` вместо `rollup` для любого проекта, зависящего от Vite, без попытки сначала поставить нативный вариант и упасть.
3. **Не полагаться на фиксированные задержки (`sleep N`) для проверки готовности dev-сервера.** В Плане Б это дважды приводило к ложным "зависаниям" (снапшот сохранялся до того, как `/tmp/vite.log` вообще появился на диске) — реальный старт Node+Vite занимал больше времени, чем заложенная пауза, из-за оверхеда CPU-эмуляции. Здесь оверхеда CPU-эмуляции нет, но общий принцип верен: **поллинг явного сигнала готовности** (лог с "ready in"/"Local:" либо промис от `vite.createServer()`'s API), а не угаданная константа.
4. **npm-метаданные больших пакетов (у `vite` — тысячи опубликованных версий) реально медленно резолвятся** — в Плане Б одно только `npm view vite version` занимало ~2.5 минуты через shared-relay. В браузере с прямым доступом к `registry.npmjs.org` (без relay-прослойки) это может быть быстрее, но `@node-lite/registry`'s резолвер обязан использовать `Accept: application/vnd.npm.install-v1+json` (сокращённый packument, тот же формат, что сам npm CLI использует для `install`; подтверждённый реальный пример — для пакета `npm` полный документ 410KB против 21KB сокращённого, разница ~20x) вместо полного `packument` — иначе тот же самый класс тормоза воспроизведётся и здесь.

### Черновой план фаз Vite (не начинать без явного отдельного решения)

- **Vite-Phase 0 (спайк):** программный запуск `vite.createServer()` внутри Worker после `esbuild-wasm` уже работает (Phase 1 основного плана) — без реальной установки самого Vite, просто заглушка модуля, проверяющая, что API-поверхность вызывается.
- **Vite-Phase 1:** реальная установка Vite через `@node-lite/registry` **с принудительным WASM-оверрайдом на Rollup с первого запроса** (см. урок №2 выше) — проверка: `node_modules/rollup` резолвится в `@rollup/wasm-node`, а не в нативный пакет, без единого падения в рантайме.
- **Vite-Phase 2:** WebSocket upgrade для HMR в `@node-lite/shims/ws.ts` + `@node-lite/network` — программная запись/правка файла в vfs триггерит `full-reload`/`update`-сообщение над этим WebSocket (тот же тест, что пытались построить в Плане Б через `ws-tunnel.ts`, здесь — без обхода через TCP-мост, поскольку никакого TCP нет, это чистый JS end-to-end).
- **Vite-Phase 3:** iframe с реальным Vite-клиентом, живая правка → HMR без перезагрузки страницы — конечная e2e-проверка через Playwright.

## Резолвер модулей и совместимость CJS/ESM

Отдельный, явно нерешённый пока архитектурный вопрос — зафиксирован здесь, чтобы не быть потерянным внутри общих описаний `vfs`/`bundler`.

**Развилка: статическая сборка (esbuild, один раз) vs настоящий рантайм-резолвер (как у Nodepod).**
`vfs` сама по себе — просто хранилище (`Map<путь, содержимое>`), она НЕ реализует алгоритм резолюции модулей Node (`require()`: поиск `node_modules` вверх по дереву директорий, `package.json#main`/`#exports`, порядок расширений `.js`/`.json`/`.node`, `index.js`-фолбэк для директорий, `"type": "module"` для определения CJS/ESM). Сейчас в плане это неявно предполагается решённым бандлером (`esbuild-wasm`'s `vfs-plugin.ts`, `onResolve`/`onLoad`) — но esbuild резолвит **статически, один раз при сборке**. Если какой-то пакет в дереве зависимостей Express делает **динамический** `require(computedPath)` (вычисляемый путь, не строковый литерал) — esbuild физически не может это разрешить на этапе сборки, это не ограничение реализации, а фундаментальное свойство статического анализа.

Nodepod, судя по заявленным возможностям ("Module System supporting require(), import, module.exports, and package.json resolution"), похоже, реализует **настоящий рантайм-резолвер** (модули резолвятся и загружаются по требованию, не одним бандлом заранее) — это принципиально другая архитектура, не просто "ещё один шим".

**Решение для v1 (фиксируется явно, не оставляется подразумеваемым):** статическая сборка через esbuild — проще, ближе к уже описанной структуре `bundler`. Динамический `require()` с вычисляемым путём — **известное, документированное ограничение v1**, той же категории, что нативные модули (raз встретили в реальном пакете — фиксируем в `docs/limitations.md`, не чиним точечными хаками). Если по факту окажется, что типичные Express-миддлвары часто используют динамический require (например, ленивая загрузка опциональных зависимостей) — это триггер для отдельного решения о переходе на модель настоящего рантайм-резолвера (аналог Nodepod), не тихая деградация.

**Gate до конца Phase 1: esbuild resolution vs настоящий Node — конформанс-тест, не предположение "совместимо".**
esbuild's резолюция похожа на Node, но не идентична побайтово (историческая тонкость с `package.json#exports`-условиями, self-referencing пакетами, `platform: 'node'` должен быть выставлен явно в конфиге esbuild — иначе резолюция будет под browser-таргет, что дальше усугубит расхождение). Acceptance-критерий Phase 1: для 5-10 реальных пакетов из зависимостей Express сравнить путь, который резолвит `esbuild-wasm` с конфигом `platform: 'node'`, против того, что реально резолвит `require.resolve()` в настоящем Node на хосте — совпадение обязательно, расхождение — блокер Phase 1, не мелкий баг.

**Gate по CJS/ESM-интеропу — явный, не подразумеваемый.**
До сдачи Phase 1 обязателен прогон трёх конкретных пакетов-представителей категорий (не абстрактная гарантия "esbuild разберётся"):
1. Чистый CommonJS (`module.exports = ...`) — например `express` сама.
2. Чистый ESM-only пакет (`"type": "module"`, только `export`) — конкретный пакет для теста фиксируется при реализации Phase 1, не откладывается на потом.
3. "Dual"-пакет с `package.json#exports`-условиями (`"import"`/`"require"` ветки одновременно).

Все три — с named-export интеропом (`import { foo } from 'cjs-pkg'`, когда `cjs-pkg` объявляет `module.exports.foo = ...`) — если хоть один не проходит, Phase 1 не считается закрытой.

## Риски

1. **`http.createServer` зависит от трёх слоёв сразу (`NetworkBridge` → `WorkerHost` → shim `http.ts`'s событийная модель) — при падении трудно локализовать, какой именно слой сломался.** Смягчение: каждый слой тестируется независимо, с мок-соседом, не только сквозным e2e:
   - `shims/http.ts` — юнит-тест на эмиссию `request`/`response`-событий с фейковым `NetworkBridge`, без реального Worker.
   - `WorkerHost.request()` — тест протокола (сырой запрос → сырой ответ) без реального `http`-шима сверху.
   - `NetworkBridge.routeRequest` — тест с фейковым `WorkerHost`.
   Если e2e-сценарий (Express-пример) падает — сначала прогоняются три изолированных набора, только потом сквозной — так падение сразу указывает на конкретный слой, а не требует ручной бисекции.
2. Worker — не аппаратная песочница (в отличие от WASM-VM StackBlitz): нет доступа к `window`/родителю, не пробрасывать креды к API потребителя, документировать честно как "изоляция для стабильности, не security-барьер".
3. Нативные зависимости — **постоянное** ограничение архитектуры, не временный недочёт (в отличие от Плана Б, где часть нативного кода всё же работает). Документировать это отличие явно, чтобы не создавать ложных ожиданий.
4. Упрощённый резолв зависимостей — без hoisting, без `devDependencies`/workspaces/`.npmrc`. Читаем и пишем `package-lock.json` строго в `lockfileVersion: 3` (актуальный формат) с полным набором полей настоящего npm — цель полная двусторонняя совместимость (импорт реального проекта и экспорт нашего в вид, который настоящий `npm install` сможет использовать без изменений), а не только ускорение установки. Свой резолвер — fallback для нового/непинованного пакета. `yarn.lock`/`pnpm-lock.yaml` не поддерживаются в v1.
5. Производительность заметно хуже настоящего WebContainer — IndexedDB-кэш по content-hash единственный рычаг для повторных запросов.
6. Браузерная поддержка зависит от SW+iframe-навигации (WebKit — риск) и CORS-доступности registry.npmjs.org.
7. `postinstall`-скрипты намеренно отключены — часть пакетов не заработает без них (принятый компромисс).
8. Тестирование browser-only частей (`worker`, `network`) невозможно в обычном node/jsdom-раннере — Playwright/vitest browser mode с самого начала.
9. При заимствовании кода из Nodebox/Nodepod — соблюдать условия их лицензий (см. таблицу выше): сохранять копирайт/лицензионные уведомления в скопированных файлах, помечать изменённые файлы как изменённые, не распространять сам код как отдельный платный продукт третьим лицам.
10. Vite вынесен в отдельный план намеренно — попытка сразу тащить его в v1 (как показал опыт Плана Б) экспоненциально увеличивает время и риск ради фичи, не входящей в изначальный приоритет (HTTP-сервер + Express-класс фреймворков).
11. VFS сама по себе не реализует алгоритм резолюции модулей Node — резолвер (статический через esbuild vs настоящий рантайм-резолвер) требует отдельного архитектурного решения, см. "Резолвер модулей и совместимость CJS/ESM" выше.

## Проверка/тестирование

Phase 0 — ручная+e2e кросс-браузерная проверка по чеклисту go/no-go выше (не общий "работает/не работает") + все 4 lifecycle-теста. Phase 1 — unit `memory-fs.ts` + резолюция-конформанс-тест (esbuild vs `require.resolve()`) + CJS/ESM-интероп gate + e2e голого http-сервера. Phase 2 — каждая под-фаза (2.0-2.9) закрывается своим acceptance-критерием отдельно, финал — реальный `npm install express` + HTTP-ответ с замером времени. Phase 3 — только ревью документации. Vite-план — не тестируется до отдельного решения о начале реализации.

## Критичные файлы

`packages/runtime/src/runtime.ts`+`types.ts` (публичный контракт), `packages/network/src/service-worker.ts`+`sw-bridge.ts`+`types.ts` (Phase 0 go/no-go, включая `previewUrlFor`), `packages/vfs/src/types.ts` и `packages/worker/src/types.ts` (контракты, фиксируются до реализации), `packages/registry/src/install.ts` (самая рискованная часть, декомпозирована выше) и `packages/registry/src/native-binary-overrides.ts` (закладывается сразу, не по результатам падений), `packages/registry/src/lockfile.ts` (package-lock v3 round-trip), `examples/express-example/`, `pnpm-workspace.yaml`.
